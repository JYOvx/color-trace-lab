import {handsFromLandmarks} from './color-tracker.js';
export class HandDetector {
  constructor(){this.worker=null;this.hands=[];this.timestamp=-Infinity;this.busy=false;this.error=null;}
  async load(){
    this.worker=new Worker(new URL('./hand-worker.js',import.meta.url));
    const worker=this.worker;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>fail(new Error('손 인식 모델 준비 시간 초과')),20000);
      const fail=error=>{clearTimeout(timer);this.error=error;reject(error);};
      worker.onerror=()=>fail(new Error('손 인식 작업을 시작하지 못했습니다.'));
      worker.onmessage=({data})=>{
        if(this.worker!==worker)return;
        if(data.type==='ready'){clearTimeout(timer);resolve();}
        if(data.type==='error'){this.busy=false;fail(new Error(data.message));}
        if(data.type==='hands'){
          this.busy=false;this.timestamp=data.timestamp;this.hands=handsFromLandmarks(data.landmarks,data.crop);
        }
      };
      worker.postMessage({type:'init'});
      this.cancelLoad=()=>{clearTimeout(timer);reject(new DOMException('손 인식 준비 취소','AbortError'));};
    });
  }
  submit(canvas,now,crop){
    if(!this.worker||this.busy||this.error)return;
    this.busy=true;const worker=this.worker;
    createImageBitmap(canvas).then(bitmap=>{
      if(this.worker!==worker){bitmap.close();return;}
      worker.postMessage({type:'frame',bitmap,timestamp:now,crop},[bitmap]);
    }).catch(error=>{if(this.worker===worker){this.busy=false;this.error=error;}});
  }
  getHands(now){return now-this.timestamp<=500?this.hands:[];}
  close(){this.cancelLoad?.();this.cancelLoad=null;this.worker?.terminate();this.worker=null;this.hands=[];this.busy=false;}
}
