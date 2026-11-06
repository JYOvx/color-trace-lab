import {COLORS, ColorHold, SUCCESS_COVERAGE} from './color-tracker.js';
import {loadOpenCV,OpenCVTracker} from './opencv-tracker.js';
import {HandDetector} from './hand-detector.js';
import {createDebugRecorder} from './debug-recorder.js';
import {trianglePath,createTraceJudge} from './trace-path.js';
const TIME_BUDGET=30000,COUNTDOWN=3000;

export function createColorPractice({video, playArea, isCameraReady}) {
  const panel=document.createElement('section');
  panel.className='color-practice';
  panel.innerHTML=`<h3>목표 색상</h3>
    <div id="color-palette" class="color-palette" role="group" aria-label="목표 색상 선택 (누르면 그 색으로 인식을 다시 시작)"></div><select id="practice-color" hidden aria-hidden="true"></select>
    <div class="target-color"><span id="color-swatch"></span><strong id="target-name">시작하면 색상이 정해져요</strong></div>
    <div class="detection-stats"><span>상자 안 색상 비율 <b id="raw-color-coverage">—</b></span><span>손에 든 물체 인정 비율 <b id="color-coverage">—</b></span><span>0.5초 유지 <b id="color-hold">—</b></span></div>
    <div class="detection-stats" aria-label="한붓그리기"><span>남은 시간 <b id="time-left">30.0초</b></span><span>현재 정확도 <b id="trace-accuracy">—</b></span><span>진행률 <b id="trace-progress">—</b></span></div>
    <progress id="hold-progress" max="1" value="0" aria-label="목표 색상 0.5초 유지 진행"></progress>
    <button id="select-held-object" class="secondary" disabled>쥔 물체 직접 지정</button><button id="auto-held-object" class="secondary" hidden>자동 손 추적으로 전환</button>
    <p id="color-status" role="status" aria-live="polite">목표 색을 고르고 아래에서 기록 시작을 누르면 게임이 시작됩니다.</p>
    <small>손이 가려져 인식되지 않으면 ‘쥔 물체 직접 지정’을 누르고 영상 속 물체를 누르세요.</small>`;
  document.querySelector('aside').append(panel);
  const $=id=>panel.querySelector(`#${id}`);
  COLORS.forEach(color=>$('practice-color').add(new Option(color.name,color.id)));
  for(const color of COLORS){
    const button=document.createElement('button');button.type='button';button.dataset.color=color.id;
    button.className='color-choice';button.setAttribute('aria-label',`${color.name} 선택`);
    const swatch=document.createElement('span');swatch.style.background=color.hex;swatch.setAttribute('aria-hidden','true');
    button.append(swatch,color.name);
    button.addEventListener('click',()=>{$('practice-color').value=color.id;$('practice-color').dispatchEvent(new Event('change'));});
    $('color-palette').append(button);
  }
  function previewChoice(){
    const color=COLORS.find(c=>c.id===$('practice-color').value);
    $('target-name').textContent=color?`선택한 색상 · ${color.name}`:'시작할 때 랜덤으로 선택합니다';
    $('color-swatch').style.background=color?.hex??'transparent';
    for(const button of $('color-palette').children)button.setAttribute('aria-pressed',String(button.dataset.color===color?.id));
  }
  previewChoice();
  // 삼각형·궤적 표시: 플레이 영역과 같은 정규화 좌표(0~1). 반전 화면이면 마커처럼 좌우를 뒤집습니다.
  const svgNS='http://www.w3.org/2000/svg',overlay=document.createElementNS(svgNS,'svg');
  overlay.setAttribute('viewBox','0 0 1 1');overlay.setAttribute('preserveAspectRatio','none');overlay.classList.add('trace-overlay');overlay.setAttribute('aria-hidden','true');playArea.append(overlay);
  const marker=document.createElement('div');marker.className='object-marker';marker.hidden=true;
  marker.setAttribute('aria-hidden','true');playArea.append(marker);
  const canvas=document.createElement('canvas');canvas.width=160;canvas.height=160;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  const hold=new ColorHold();
  const handCanvas=document.createElement('canvas');handCanvas.width=320;handCanvas.height=320;
  const handContext=handCanvas.getContext('2d');
  let handDetector=null,generation=0,lastHandAt=-Infinity,lastTargetAt=-Infinity;
  let tracker=null;
  let active=false,found=false,target=null,previous=null,lastProcessed=-Infinity,frameId=null;
  let practiceReady=false;
  let manualPoint=null,manualLock=false,selecting=false;
  let phase=null,searchStart=0,remaining=TIME_BUDGET,countdownUntil=0,drawStart=0,path=null,judge=null,lost=false,outcome=null;
  function timeLeft(now){return phase==='search'?TIME_BUDGET-(now-searchStart):phase==='countdown'?remaining:phase==='draw'?remaining-(now-drawStart):Math.max(0,remaining);}
  function renderOverlay(){
    overlay.replaceChildren();overlay.style.transform=video.classList.contains('mirrored')?'scaleX(-1)':'';
    if(!path)return;
    const el=(name,attrs)=>{const node=document.createElementNS(svgNS,name);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,v);overlay.append(node);return node;};
    if(phase!=='countdown')el('polygon',{points:path.vertices.map(p=>`${p.x},${p.y}`).join(' '),class:'trace-target'});
    el('circle',{cx:path.start.x,cy:path.start.y,r:.06,class:'trace-start'});
    const s=judge?.state();if(!s?.points.length)return;
    // 실제 검출 궤적은 실선, 끊김 뒤 복원한 직선은 점선(확정 규칙).
    s.points.forEach((p,i)=>{if(!i)return;const a=s.points[i-1];el('line',{x1:a.x,y1:a.y,x2:p.x,y2:p.y,class:s.restoredSegments.includes(i)?'trace-line restored':'trace-line'});});
  }
  let lastTime=-1;
  // 기록 시작 = 게임 시작, 기록 종료(직접·38초 상한·카메라 끄기) = 게임 초기화.
  const debug=createDebugRecorder({video,container:document.querySelector('aside'),isCameraReady,onStart:()=>void start(),onStop:()=>reset('기록을 마쳤습니다. 기록 시작을 누르면 게임을 다시 시작합니다.')});
  function cancelFrame(){
    if(frameId===null)return;
    if(video.requestVideoFrameCallback)video.cancelVideoFrameCallback(frameId);
    else cancelAnimationFrame(frameId);
    frameId=null;
  }
  function reset(message='목표 색을 고르고 아래에서 기록 시작을 누르면 게임이 시작됩니다.') {
    for(const button of $('color-palette').children)button.disabled=false;
    manualPoint=null;manualLock=false;selecting=false;
    $('select-held-object').disabled=true;$('auto-held-object').hidden=true;
    video.parentElement.classList.remove('selecting-object');
    debug.event('practice-reset');
    debug.setTelemetry({timestamp:performance.now(),color:null,hands:[],target:null,reason:'PRACTICE_IDLE',rawCoverage:0,coverage:0});
    generation++;handDetector?.close();handDetector=null;
    lastHandAt=-Infinity;lastTargetAt=-Infinity;
    active=false;cancelFrame();found=false;previous=null;hold.reset();
    marker.hidden=true;playArea.classList.remove('color-found');
    phase=null;path=null;judge=null;lost=false;outcome=null;remaining=TIME_BUDGET;renderOverlay();
    $('time-left').textContent='30.0초';$('trace-accuracy').textContent='—';$('trace-progress').textContent='—';
    $('raw-color-coverage').textContent='—';$('color-coverage').textContent='—';$('color-hold').textContent='—';$('hold-progress').value=0;
    $('color-status').textContent=message;
    previewChoice();
  }
  function updateReady(ready){
    practiceReady=ready;
    debug.updateReady();
    if(!ready)reset();
  }
  function schedule(){
    if(!active)return;
    frameId=video.requestVideoFrameCallback ? video.requestVideoFrameCallback(process) : requestAnimationFrame(process);
  }
  function process(now){
    frameId=null;
    if(!active||!isCameraReady())return;
    if(document.hidden){hold.reset();schedule();return;}
    if(now-lastProcessed<80||video.readyState<2||video.currentTime===lastTime){schedule();return;}
    lastTime=video.currentTime;lastProcessed=now;
    try {
      // Crop the source video, not the CSS-scaled or mirrored display.
      const side=Math.min(video.videoWidth,video.videoHeight)*.8;
      context.drawImage(video,(video.videoWidth-side)/2,(video.videoHeight-side)/2,side,side,0,0,160,160);
      // Detect hands across the whole frame, including fingers outside the play area.
      const scale=Math.min(1,640/Math.max(video.videoWidth,video.videoHeight));
      const handWidth=Math.round(video.videoWidth*scale),handHeight=Math.round(video.videoHeight*scale);
      if(handCanvas.width!==handWidth||handCanvas.height!==handHeight){handCanvas.width=handWidth;handCanvas.height=handHeight;}
      handContext.drawImage(video,0,0,handWidth,handHeight);
      if(handDetector.error)throw handDetector.error;
      handDetector.submit(handCanvas,now,{x:(video.videoWidth-side)/2/video.videoWidth,y:(video.videoHeight-side)/2/video.videoHeight,width:side/video.videoWidth,height:side/video.videoHeight});
      const hands=handDetector.getHands(now);
      if(hands.length)lastHandAt=handDetector.timestamp;
      const result=tracker.analyze(context.getImageData(0,0,160,160),target.id,previous,!found,{hands,now,lastHandAt,lastTargetAt,manualPoint,manualLock});
      if(manualPoint){manualPoint=null;if(result.target){selecting=false;video.parentElement.classList.remove('selecting-object');}}
      const state=hold.update(result.target ? result.coverage : 0,now);
      debug.setTelemetry({engine:result.engine,selectionMode:manualLock?'manual-held-object':'automatic-hand-contact',timestamp:now,videoTime:video.currentTime,color:target.id,rawCoverage:result.rawCoverage,coverage:result.coverage,hands,handAgeMs:Number.isFinite(handDetector.timestamp)?now-handDetector.timestamp:null,target:result.target,candidateCount:result.candidateCount,candidates:result.candidates,reason:result.reason,rejectionCounts:result.rejectionCounts,diagnostics:result.diagnostics,holdProgress:state.progress,found:state.success,mirrored:video.classList.contains('mirrored'),phase,timeLeftMs:Math.round(timeLeft(now)),outcome,path:path?.vertices??null,trace:judge?(({started,direction,passed,accuracy,complete})=>({started,direction,passed,accuracy,complete}))(judge.state()):null});
      $('raw-color-coverage').textContent=`${(result.rawCoverage*100).toFixed(1)}%`;
      $('color-coverage').textContent=`${(result.coverage*100).toFixed(1)}%`;
      $('color-hold').textContent=`${(state.progress*.5).toFixed(1)}초`;
      $('hold-progress').value=state.progress;
      if(result.target){
        previous=result.target;
        lastTargetAt=now;
        const mirror=video.classList.contains('mirrored');
        marker.style.left=`${(mirror?1-result.target.x:result.target.x)*100}%`;
        marker.style.top=`${result.target.y*100}%`;marker.hidden=false;
      } else marker.hidden=true;
      if(phase==='search'&&state.success){
        // 색상 찾기 성공: 남은 시간을 보존하고 3초 준비(시간 차감 없음) 동안 시작점만 보여 줍니다.
        remaining=Math.max(0,TIME_BUDGET-(now-searchStart));phase='countdown';countdownUntil=now+COUNTDOWN;
        path=trianglePath(true,video.classList.contains('mirrored'));judge=createTraceJudge(path.vertices);debug.event('trace-countdown');
      } else if(phase==='search'&&now-searchStart>=TIME_BUDGET){phase='done';outcome='color-failed';debug.event('trace-color-failed');}
      if(phase==='countdown'&&now>=countdownUntil){phase='draw';drawStart=now;lost=false;debug.event('trace-draw-start');}
      if(phase==='draw'){
        if(result.target){judge.add({x:result.target.x,y:result.target.y},{restored:lost});lost=false;}else lost=true;
        const s=judge.state();
        if(s.complete){remaining=timeLeft(now);phase='done';outcome='complete';debug.event(`trace-complete:${s.accuracy.toFixed(1)}`);}
        else if(timeLeft(now)<=0){remaining=0;phase='done';outcome='timeout';debug.event('trace-timeout');}
      }
      const ts=judge?.state();
      $('time-left').textContent=`${(Math.max(0,timeLeft(now))/1000).toFixed(1)}초`;
      $('trace-accuracy').textContent=ts?.started&&ts.accuracy!==null?`${ts.accuracy.toFixed(1)}%`:'—';
      $('trace-progress').textContent=ts?`${Math.round(ts.progress*100)}%`:'—';
      renderOverlay();
      if(state.success){
        found=true;playArea.classList.add('color-found');
        $('color-status').textContent=result.target?'색상 찾기 성공! 손에 든 물체를 점선 영역 안에서 움직여 보세요.':'추적 끊김 · 손과 물체를 함께 보여주세요. 배경으로 대상을 바꾸지 않고 기다립니다.';
      } else $('color-status').textContent=!hands.length?(result.rawCoverage>0?`${target.name} 색상은 보이지만 손을 찾지 못했어요. 물체 옆으로 손가락을 더 보여주세요.`:'손을 찾고 있어요. 물체와 손가락을 함께 보여주세요.'):!result.target?'손 주변에서 목표 색상 물체를 찾고 있어요.':result.coverage>=SUCCESS_COVERAGE?'좋아요! 이 상태를 0.5초 유지해 주세요.':`중앙 상자의 ${SUCCESS_COVERAGE*100}% 이상을 손에 든 목표 색상 물체로 채워 주세요.`;
      const phaseMessage=phase==='countdown'?`${Math.ceil((countdownUntil-now)/1000)}초 뒤 시작 · 물체를 동그라미(시작점)로 옮기세요.`:phase==='draw'?(!ts.started?'시작점으로 이동하세요.':!result.target?'물체를 영역 안에 보여주세요. 시간은 계속 흐릅니다.':'삼각형을 따라 한 번에 그려 시작점으로 돌아오세요.'):phase==='done'?{complete:`완성! 정확도 ${ts?.accuracy?.toFixed(1)}% · 기록 종료 후 다시 기록하면 새 게임입니다.`,timeout:'시간 종료 · 미완성입니다. 기록 종료 후 다시 기록하면 새 게임입니다.','color-failed':'30초 안에 색을 찾지 못했습니다. 기록 종료 후 다시 기록하면 새 게임입니다.'}[outcome]:null;
      if(manualLock&&!phaseMessage)$('color-status').textContent=selecting?'영상 속 쥔 물체의 목표색 부분을 클릭하세요.':!result.target?'지정한 물체를 놓쳤습니다. 다른 배경으로 바꾸지 않습니다. 직접 지정을 눌러 다시 선택해 주세요.':found?'지정한 물체 추적 중 · 색상 찾기 성공':result.coverage>=SUCCESS_COVERAGE?'지정한 물체 확인 · 이 상태를 0.5초 유지하세요.':'지정한 물체를 중앙 상자에 더 가까이 대 주세요.';
      if(phaseMessage)$('color-status').textContent=phaseMessage;
    } catch(error) {
      debug.event(`analysis-error:${error.name}`);
      reset('영상 분석을 중단했습니다. 카메라를 다시 연결한 뒤 재시도해 주세요.');
      return;
    }
    schedule();
  }
  async function start(){
    if(!isCameraReady())return;
    reset();
    // 게임 중에는 목표 색을 바꾸지 않습니다(기록 한 개 = 색 한 개).
    for(const button of $('color-palette').children)button.disabled=true;
    const version=generation;
    $('color-status').textContent='OpenCV와 손 인식 모델을 준비하고 있어요…';
    const detector=new HandDetector();handDetector=detector;
    try{const [{cv}]=await Promise.all([loadOpenCV(),detector.load()]);tracker=new OpenCVTracker(cv);}catch(error){
      if(version!==generation)return;
      reset('OpenCV 또는 손 인식을 준비하지 못했습니다. 기록을 종료한 뒤 다시 시작해 주세요.');return;
    }
    if(version!==generation)return;
    target=COLORS.find(color=>color.id===$('practice-color').value)??COLORS[Math.floor(Math.random()*COLORS.length)];
    $('target-name').textContent=`목표 색상 · ${target.name}`;$('color-swatch').style.background=target.hex;
    marker.style.setProperty('--target-color',target.hex);
    $('color-status').textContent='중앙 상자 안에 목표 색상 물체를 가까이 대 주세요.';
    active=true;lastProcessed=-Infinity;lastTime=-1;phase='search';searchStart=performance.now();debug.event(`game-start:${target.id}`);schedule();
    $('select-held-object').disabled=false;
  }
  function clearObjectLock(){previous=null;lastTargetAt=-Infinity;marker.hidden=true;hold.reset();if(found)hold.success=true;}
  $('select-held-object').addEventListener('click',()=>{
    if(!active)return;clearObjectLock();manualLock=true;manualPoint=null;selecting=true;
    $('auto-held-object').hidden=false;video.parentElement.classList.add('selecting-object');debug.event('manual-held-object-selection-armed');
    $('color-status').textContent='영상 속 쥔 물체의 목표색 부분을 클릭하세요.';
  });
  video.parentElement.addEventListener('click',event=>{
    if(!active||!selecting)return;
    const rect=playArea.getBoundingClientRect();let x=(event.clientX-rect.left)/rect.width;const y=(event.clientY-rect.top)/rect.height;
    if(x<0||x>=1||y<0||y>=1){$('color-status').textContent='물체를 점선 플레이 영역 안에 놓고 클릭해 주세요. 손은 밖에 있어도 됩니다.';return;}
    if(video.classList.contains('mirrored'))x=1-x;
    manualPoint={x,y};clearObjectLock();debug.event(`manual-held-object-point:${x.toFixed(3)},${y.toFixed(3)}`);
  });
  $('auto-held-object').addEventListener('click',()=>{clearObjectLock();manualLock=false;manualPoint=null;selecting=false;$('auto-held-object').hidden=true;video.parentElement.classList.remove('selecting-object');debug.event('automatic-hand-contact-selection');});
  // A new tab-visible frame must establish a fresh continuous 0.5 second hold.
  document.addEventListener('visibilitychange',()=>{if(!found)hold.reset();});
  $('practice-color').addEventListener('change',()=>{if(!active)previewChoice();});
  return {updateReady,stop:()=>{debug.stop();reset();}};
}
