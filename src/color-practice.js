import {COLORS, ColorHold} from './color-tracker.js';
import {loadOpenCV,OpenCVTracker} from './opencv-tracker.js';
import {HandDetector} from './hand-detector.js';
import {createDebugRecorder} from './debug-recorder.js';

export function createColorPractice({video, playArea, isCameraReady}) {
  const panel=document.createElement('section');
  panel.className='color-practice';
  panel.innerHTML=`<hr><span class="eyebrow">COLOR CHECK</span><h3>색상 찾기를 연습해요</h3>
    <label for="practice-color">테스트할 색상을 선택하세요</label><div id="color-palette" class="color-palette" role="group" aria-label="테스트 색상 선택"></div><select id="practice-color" aria-label="테스트 색상 또는 랜덤 선택"></select>
    <div class="target-color"><span id="color-swatch"></span><strong id="target-name">시작하면 색상이 정해져요</strong></div>
    <div class="detection-stats"><span>상자 안 색상 비율 <b id="raw-color-coverage">—</b></span><span>손에 든 물체 인정 비율 <b id="color-coverage">—</b></span><span>0.5초 유지 <b id="color-hold">—</b></span></div>
    <progress id="hold-progress" max="1" value="0" aria-label="목표 색상 0.5초 유지 진행"></progress>
    <button id="color-start" class="primary" disabled>색상 인식 시작</button>
    <button id="select-held-object" class="secondary" disabled>쥔 물체 직접 지정</button><button id="auto-held-object" class="secondary" hidden>자동 손 추적으로 전환</button>
    <p id="color-status" role="status" aria-live="polite">카메라를 연결하고 준비 완료를 눌러 주세요.</p>
    <small>물체의 목표색 부분만 중앙 상자를 절반 이상 채우면 됩니다. 손은 상자·점선 밖에 있어도 되지만 카메라에는 보여야 합니다. 손이 가려져 인식되지 않으면 ‘쥔 물체 직접 지정’을 누르고 영상 속 목표색 부분을 클릭하세요.</small>`;
  document.querySelector('aside .checklist').parentElement.insertBefore(panel,document.querySelector('aside hr'));
  const $=id=>panel.querySelector(`#${id}`);
  COLORS.forEach(color=>$('practice-color').add(new Option(color.name,color.id)));
  $('practice-color').add(new Option('랜덤 선택으로 테스트','random'));
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
  let lastTime=-1;
  const debug=createDebugRecorder({video,container:document.querySelector('aside'),isCameraReady});
  function cancelFrame(){
    if(frameId===null)return;
    if(video.requestVideoFrameCallback)video.cancelVideoFrameCallback(frameId);
    else cancelAnimationFrame(frameId);
    frameId=null;
  }
  function reset(message='카메라를 연결하고 준비 완료를 눌러 주세요.') {
    manualPoint=null;manualLock=false;selecting=false;
    $('select-held-object').disabled=true;$('auto-held-object').hidden=true;
    video.parentElement.classList.remove('selecting-object');
    debug.event('practice-reset');
    debug.setTelemetry({timestamp:performance.now(),color:null,hands:[],target:null,reason:'PRACTICE_IDLE',rawCoverage:0,coverage:0});
    generation++;handDetector?.close();handDetector=null;
    lastHandAt=-Infinity;lastTargetAt=-Infinity;
    active=false;cancelFrame();found=false;previous=null;hold.reset();
    marker.hidden=true;playArea.classList.remove('color-found');
    $('raw-color-coverage').textContent='—';$('color-coverage').textContent='—';$('color-hold').textContent='—';$('hold-progress').value=0;
    $('color-status').textContent=message;$('color-start').textContent='색상 인식 시작';
    previewChoice();$('color-start').disabled=!practiceReady;
  }
  function updateReady(ready){
    practiceReady=ready;
    debug.updateReady();
    $('color-start').disabled=!ready;
    if(!ready)reset(isCameraReady()?'준비 완료를 눌러 주세요.':'카메라를 연결하고 준비 완료를 눌러 주세요.');
    else if(!active)$('color-status').textContent='준비됐어요. 색상 인식을 시작해 주세요.';
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
      debug.setTelemetry({engine:result.engine,selectionMode:manualLock?'manual-held-object':'automatic-hand-contact',timestamp:now,videoTime:video.currentTime,color:target.id,rawCoverage:result.rawCoverage,coverage:result.coverage,hands,handAgeMs:Number.isFinite(handDetector.timestamp)?now-handDetector.timestamp:null,target:result.target,candidateCount:result.candidateCount,candidates:result.candidates,reason:result.reason,rejectionCounts:result.rejectionCounts,diagnostics:result.diagnostics,holdProgress:state.progress,found:state.success,mirrored:video.classList.contains('mirrored')});
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
      if(state.success){
        found=true;playArea.classList.add('color-found');
        $('color-status').textContent=result.target?'색상 찾기 성공! 손에 든 물체를 점선 영역 안에서 움직여 보세요.':'추적 끊김 · 손과 물체를 함께 보여주세요. 배경으로 대상을 바꾸지 않고 기다립니다.';
      } else $('color-status').textContent=!hands.length?(result.rawCoverage>0?`${target.name} 색상은 보이지만 손을 찾지 못했어요. 물체 옆으로 손가락을 더 보여주세요.`:'손을 찾고 있어요. 물체와 손가락을 함께 보여주세요.'):!result.target?'손 주변에서 목표 색상 물체를 찾고 있어요.':result.coverage>=.5?'좋아요! 이 상태를 0.5초 유지해 주세요.':'중앙 상자의 절반 이상을 손에 든 목표 색상 물체로 채워 주세요.';
      if(manualLock)$('color-status').textContent=selecting?'영상 속 쥔 물체의 목표색 부분을 클릭하세요.':!result.target?'지정한 물체를 놓쳤습니다. 다른 배경으로 바꾸지 않습니다. 직접 지정을 눌러 다시 선택해 주세요.':found?'지정한 물체 추적 중 · 색상 찾기 성공':result.coverage>=.5?'지정한 물체 확인 · 이 상태를 0.5초 유지하세요.':'지정한 물체를 중앙 상자에 더 가까이 대 주세요.';
    } catch(error) {
      debug.event(`analysis-error:${error.name}`);
      reset('영상 분석을 중단했습니다. 카메라를 다시 연결한 뒤 재시도해 주세요.');
      return;
    }
    schedule();
  }
  $('color-start').addEventListener('click',async()=>{
    if(!isCameraReady())return;
    reset();
    const version=generation;
    $('color-start').disabled=true;$('color-status').textContent='OpenCV와 손 인식 모델을 준비하고 있어요…';
    const detector=new HandDetector();handDetector=detector;
    try{const [{cv}]=await Promise.all([loadOpenCV(),detector.load()]);tracker=new OpenCVTracker(cv);}catch(error){
      if(version!==generation)return;
      reset('OpenCV 또는 손 인식을 준비하지 못했습니다. 다시 시작해 주세요.');
      $('color-start').disabled=false;return;
    }
    if(version!==generation)return;
    $('color-start').disabled=false;
    target=COLORS.find(color=>color.id===$('practice-color').value)??COLORS[Math.floor(Math.random()*COLORS.length)];
    $('target-name').textContent=`목표 색상 · ${target.name}`;$('color-swatch').style.background=target.hex;
    marker.style.setProperty('--target-color',target.hex);
    $('color-start').textContent='다시 시작';$('color-status').textContent='중앙 상자 안에 목표 색상 물체를 가까이 대 주세요.';
    active=true;lastProcessed=-Infinity;lastTime=-1;schedule();
    $('select-held-object').disabled=false;
  });
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
  $('practice-color').addEventListener('change',()=>{reset('선택한 색상으로 테스트하려면 색상 인식 시작을 눌러 주세요.');});
  return {updateReady,stop:()=>{debug.stop();reset();$('color-start').disabled=true;}};
}
