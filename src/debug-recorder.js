import {COLORS} from './color-tracker.js';
import {UPLOAD_URL,APP_VERSION} from './upload-config.js';
// 원격 모드: 링크의 #key=... 를 읽어 이 탭에만 보관하고 주소창에서 지웁니다(화면 공유·복사로 새지 않게).
let uploadKey='';
if(UPLOAD_URL){
  try{
    const match=location.hash.match(/(?:^#|&)key=([^&]+)/);
    if(match){uploadKey=decodeURIComponent(match[1]);sessionStorage.setItem('color-trace.upload-key',uploadKey);history.replaceState(null,'',location.pathname+location.search);}
    else uploadKey=sessionStorage.getItem('color-trace.upload-key')??'';
  }catch{/* 저장소가 막혀도 이번 페이지에서는 match 값으로 동작 */}
}
const REMOTE_ERRORS={forbidden:'링크의 키가 맞지 않습니다. 받은 링크 전체를 다시 열어 주세요.','daily-limit':'오늘 저장 가능 횟수를 넘었습니다. 담당자에게 알려 주세요.','too-large':'기록이 너무 큽니다. 더 짧게 찍어 주세요.','invalid':'기록 형식이 올바르지 않습니다.','server-not-configured':'저장소 설정이 끝나지 않았습니다. 담당자에게 알려 주세요.'};
const toBase64=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]??'');reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
async function uploadRemote(pending){
  let contributor='';try{contributor=sessionStorage.getItem('color-trace.nickname')??'';}catch{}
  const body=JSON.stringify({key:uploadKey,contributor,trace:pending.trace,video:{type:pending.video.type,data:await toBase64(pending.video)},snapshots:await Promise.all(pending.snapshots.filter(Boolean).map(toBase64))});
  // text/plain이면 CORS 사전 요청 없이 Apps Script로 보낼 수 있습니다.
  const response=await fetch(UPLOAD_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body,signal:AbortSignal.timeout(120000)});
  const result=await response.json().catch(()=>({error:'bad-response'}));
  if(!result.ok){const error=new Error(result.error??'upload-failed');error.userMessage=REMOTE_ERRORS[result.error];throw error;}
  return {path:`Google Drive / ${result.id}`};
}
// 촬영 목록: 보정 분석에서 상황별로 묶어 비교하는 기준. id는 로그에 그대로 남으므로 바꾸지 않습니다.
export const SCENARIOS=[
  ['still','가만히 들기','물체를 중앙 상자 안에 들고 움직이지 않기'],
  ['move-slow','천천히 움직이기','상자 안팎으로 천천히 옮기기'],
  ['move-fast','빨리 움직이기','빠르게 흔들거나 옮기기'],
  ['tight-grip','꽉 쥐기','손가락으로 물체를 많이 가리게 쥐기'],
  ['same-color-bg','배경에 같은 색','뒤쪽에 같은 색 물건을 두고 들기'],
  ['hand-only','물체 없이 손만','물체 없이 손·팔만 상자 앞에서 움직이기 (피부 오인식 확인)'],
  ['distance-angle','멀리·기울이기','카메라에서 멀어지거나 물체를 돌리기'],
  ['lighting','조명·반사 변화','조명 아래·그늘을 오가거나 반사되게 들기'],
  ['other','기타','메모에 상황 적기'],
];
export function createDebugRecorder({video,container,isCameraReady,onStart=()=>{},onStop=()=>{}}){
  const panel=document.createElement('section');panel.className='debug-panel';
  panel.innerHTML=`<hr><h3>테스트 기록</h3>
    <label for="debug-scenario">촬영 상황 (필수)</label><select id="debug-scenario"><option value="">선택하세요</option>${SCENARIOS.map(([id,name,hint])=>`<option value="${id}">${name} — ${hint}</option>`).join('')}</select>
    <label for="debug-object">손에 든 물체의 실제 색 (필수)</label><select id="debug-object"><option value="">선택하세요</option>${COLORS.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}<option value="none">물체 없음</option><option value="mixed">여러 색·애매함</option></select>
    <div class="debug-actions"><button id="debug-toggle" class="secondary" disabled>기록 시작</button><button id="debug-mark" class="secondary" disabled>문제 순간 표시</button></div>
    <p id="debug-status" role="status" aria-live="polite">${UPLOAD_URL&&!uploadKey?'저장 키가 없어 기록할 수 없습니다. 받은 링크 전체(#key=... 포함)로 다시 열어 주세요.':'카메라 연결 후 기록할 수 있어요.'}</p><button id="debug-retry" class="secondary" hidden>저장 재시도</button>
    <label for="debug-notes">문제 상황 메모</label><textarea id="debug-notes" maxlength="500" rows="2" placeholder="예: 파란 봉지를 움직이면 배경으로 튀어요"></textarea>
    <small>${UPLOAD_URL?'기록 시작을 누르면 카메라 영상(얼굴 포함)·손 위치·추적 로그를 프로젝트 담당자의 Google Drive 비공개 폴더로 보냅니다. 다른 참가자는 볼 수 없습니다.':'기록 시작을 누르면 카메라 영상·손 위치·추적 로그를 이 PC의 debug-recordings 폴더에 저장합니다.'} 음성은 기록하지 않습니다. 최대 38초(색 찾기·그리기 30초 + 준비 3초)입니다.</small>`;
  container.append(panel);const $=id=>panel.querySelector(`#${id}`);
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  let recorder=null,capture=null,paintTimer=null,limitTimer=null,start=0,latest=null,samples=[],events=[],chunks=[],snapshots=[],snapshotTimes=[],snapshotJobs=[],lastSnapshot=-Infinity;
  let recording=false,saving=false,finishing=false,pending=null,videoError=null;
  const labeled=()=>!!$('debug-scenario').value&&!!$('debug-object').value;
  function readiness(){
    $('debug-toggle').disabled=finishing||saving||!!pending||(!recording&&(!isCameraReady()||!labeled()))||!window.MediaRecorder||(!!UPLOAD_URL&&!uploadKey);
    if(UPLOAD_URL&&!uploadKey)$('debug-status').textContent='저장 키가 없어 기록할 수 없습니다. 받은 링크 전체(#key=... 포함)로 다시 열어 주세요.';
    $('debug-scenario').disabled=$('debug-object').disabled=recording||finishing||saving||!!pending;
  }
  $('debug-scenario').addEventListener('change',readiness);$('debug-object').addEventListener('change',readiness);
  function setTelemetry(sample){latest=sample;if(recording)samples.push({...sample,tMs:Math.round(performance.now()-start)});}
  function draw(){
    if(!video.videoWidth)return;
    const w=canvas.width,h=canvas.height,mirror=video.classList.contains('mirrored');
    ctx.save();if(mirror){ctx.translate(w,0);ctx.scale(-1,1);}ctx.drawImage(video,0,0,w,h);ctx.restore();
    const side=Math.min(w,h)*.8,left=(w-side)/2,top=(h-side)/2;
    ctx.strokeStyle='#ffffff';ctx.lineWidth=2;ctx.setLineDash([6,5]);ctx.strokeRect(left,top,side,side);ctx.setLineDash([]);
    ctx.strokeStyle='#ffd34a';ctx.strokeRect(left+side*.35,top+side*.35,side*.3,side*.3);
    const point=(p,color,size)=>{ctx.beginPath();ctx.fillStyle=color;ctx.arc(left+(mirror?1-p.x:p.x)*side,top+p.y*side,size,0,Math.PI*2);ctx.fill();};
    // Expired telemetry is not drawn as a fresh detection.
    const fresh=latest&&performance.now()-latest.timestamp<700;
    if(latest?.path&&latest.phase!=='countdown'){ctx.strokeStyle='#ffffffcc';ctx.lineWidth=2;ctx.beginPath();latest.path.forEach((p,i)=>{const x=left+(mirror?1-p.x:p.x)*side,y=top+p.y*side;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.closePath();ctx.stroke();}
    if(fresh){for(const hand of latest.hands??[])for(const p of hand.points)point(p,'#fcd34d',2);if(latest.target)point(latest.target,'#22f39b',7);}
    ctx.fillStyle='#102039d9';ctx.fillRect(0,0,w,66);ctx.fillStyle='white';ctx.font='13px sans-serif';
    ctx.fillText(`REC ${((performance.now()-start)/1000).toFixed(1)}s | ${latest?.color??'not-started'} | ${fresh?latest.reason:'NO_FRESH_SAMPLE'}`,10,22);
    ctx.fillText(`color ${((latest?.rawCoverage??0)*100).toFixed(1)}% | accepted ${((latest?.coverage??0)*100).toFixed(1)}% | hands ${fresh?latest.hands.length:0} | ${latest?.phase??'-'} ${latest?.trace?`${latest.trace.passed}/12 acc ${latest.trace.accuracy?.toFixed(1)??'-'}`:''}`,10,45);
    if(performance.now()-lastSnapshot>=2000){
      lastSnapshot=performance.now();const t=Math.round(lastSnapshot-start);const index=snapshots.length;snapshots.push(null);snapshotTimes.push(t);
      snapshotJobs.push(new Promise(resolve=>canvas.toBlob(blob=>{snapshots[index]=blob;resolve();},'image/jpeg',.8)));
    }
    $('debug-toggle').textContent=`기록 종료 · ${Math.floor((performance.now()-start)/1000)}초`;
  }
  async function save(){
    if(!pending||saving)return;saving=true;readiness();$('debug-retry').hidden=true;$('debug-status').textContent=UPLOAD_URL?'Google Drive로 보내는 중입니다(최대 1~2분). 완료될 때까지 이 페이지를 유지해 주세요.':'로컬 폴더에 저장 중입니다. 완료될 때까지 이 페이지를 유지해 주세요.';
    try{
      let result;
      if(UPLOAD_URL)result=await uploadRemote(pending);
      else{
        const form=new FormData();form.append('video',pending.video,pending.video.type.startsWith('video/mp4')?'recording.mp4':'recording.webm');form.append('trace',JSON.stringify(pending.trace));
        pending.snapshots.forEach(blob=>{if(blob)form.append('snapshot',blob,'frame.jpg');});
        const response=await fetch('/api/debug-recordings',{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
        if(!response.ok)throw new Error(`저장 응답 ${response.status}`);
        result=await response.json();
      }
      pending=null;
      $('debug-status').textContent=`저장 완료: ${result.path}${videoError?' (영상 기록 오류가 있어 부분 기록입니다.)':''}`;
    }catch(error){$('debug-status').textContent=`저장에 실패했습니다. ${error.userMessage??(UPLOAD_URL?'인터넷 연결을 확인한 뒤':'로컬 서버를 확인한 뒤')} 저장 재시도를 눌러 주세요. 기록은 이 탭에 보관 중입니다.`;$('debug-retry').hidden=false;}
    finally{saving=false;readiness();}
  }
  function finish(reason='manual'){
    if(!recording)return;
    events.push({tMs:Math.round(performance.now()-start),type:'stop',reason});recording=false;finishing=true;onStop(reason);
    clearInterval(paintTimer);clearTimeout(limitTimer);
    $('debug-toggle').textContent='기록 시작';$('debug-mark').disabled=true;$('debug-toggle').disabled=true;
    if(recorder.state!=='inactive')recorder.stop();
  }
  $('debug-toggle').addEventListener('click',()=>{
    if(recording){finish();return;}
    if(!isCameraReady()||pending||!labeled())return;
    const scenario=$('debug-scenario').value,objectColor=$('debug-object').value;
    if(!window.MediaRecorder||!canvas.captureStream){$('debug-status').textContent='이 브라우저는 영상 기록을 지원하지 않습니다. Chrome 또는 Edge에서 시도해 주세요.';return;}
    try{
      const scale=Math.min(1,640/Math.max(video.videoWidth,video.videoHeight));canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
      samples=[];events=[];chunks=[];snapshots=[];snapshotTimes=[];snapshotJobs=[];lastSnapshot=-Infinity;videoError=null;
      start=performance.now();const startedAt=new Date().toISOString();recording=true;
      capture=canvas.captureStream(15);
      const mime=['video/webm;codecs=vp8','video/webm','video/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
      recorder=new MediaRecorder(capture,{...(mime?{mimeType:mime}:{}),videoBitsPerSecond:1500000});
      recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
      recorder.onerror=event=>{videoError=event.error?.name??'MediaRecorderError';finish('recorder-error');};
      recorder.onstop=async()=>{
        const durationMs=Math.round(performance.now()-start);
        capture.getTracks().forEach(track=>track.stop());
        await Promise.all(snapshotJobs);
        pending={video:new Blob(chunks,{type:recorder.mimeType}),snapshots,trace:{schemaVersion:1,startedAt,durationMs,scenario,objectColor,appVersion:APP_VERSION,notes:$('debug-notes').value.slice(0,500),userAgent:navigator.userAgent,video:{width:canvas.width,height:canvas.height,muted:true},samples,events,snapshotTimesMs:snapshotTimes,videoError}};
        finishing=false;
        await save();
      };
      recorder.start(1000);onStart();draw();paintTimer=setInterval(draw,1000/15);limitTimer=setTimeout(()=>finish('38-second-limit'),38000);
      $('debug-status').textContent='● 기록 중 · 영상과 로그는 이 PC에만 저장합니다.';$('debug-mark').disabled=false;
    }catch(error){recording=false;capture?.getTracks().forEach(track=>track.stop());$('debug-status').textContent='기록을 시작하지 못했습니다. 브라우저의 영상 기록 지원을 확인해 주세요.';readiness();}
  });
  $('debug-mark').addEventListener('click',()=>{if(recording){events.push({tMs:Math.round(performance.now()-start),type:'user-mark',note:$('debug-notes').value.slice(0,500)});$('debug-status').textContent=`문제 순간 표시: ${((performance.now()-start)/1000).toFixed(1)}초`;} });
  $('debug-retry').addEventListener('click',save);
  window.addEventListener('beforeunload',event=>{if(recording||finishing||saving||pending){event.preventDefault();event.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)finish('tab-hidden');});
  return {setTelemetry,updateReady:readiness,stop:()=>finish('camera-or-practice-stopped'),event:type=>{if(recording)events.push({type,tMs:Math.round(performance.now()-start)});}};
}
