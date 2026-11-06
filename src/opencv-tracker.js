import {COLORS,evaluateHeldCandidates} from './color-tracker.js';
let loading;
export function loadOpenCV(){
  if(loading)return loading;
  loading=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=new URL('../vendor/opencv/opencv.js',import.meta.url).href;script.async=true;
    const timer=setTimeout(()=>reject(new Error('OpenCV 준비 시간 초과')),20000);
    script.onerror=()=>{clearTimeout(timer);script.remove();reject(new Error('OpenCV 파일을 불러오지 못했습니다.'));};
    script.onload=()=>{
      // 4.9's module is a self-resolving Emscripten thenable, not a native Promise.
      // Wrap it so Promise assimilation never recursively awaits the module itself.
      const ready=cv=>{try{if(!cv?.Mat||!cv.connectedComponentsWithStats)throw new Error('필요한 OpenCV 기능이 없습니다.');clearTimeout(timer);resolve({cv});}catch(error){clearTimeout(timer);reject(error);}};
      const cv=window.cv;
      if(typeof cv?.then==='function')cv.then(ready);
      else if(cv?.Mat)ready(cv);
      else{clearTimeout(timer);reject(new Error('OpenCV 모듈을 초기화하지 못했습니다.'));}
    };
    document.head.append(script);
  }).catch(error=>{loading=null;throw error;});
  return loading;
}

export class OpenCVTracker {
  constructor(cv){this.cv=cv;}
  analyze(image,colorId,previous=null,searchOnly=true,handContext=null){
    const cv=this.cv,{width,height}=image,size=width*height;
    const allocated=[];const own=mat=>{allocated.push(mat);return mat;};
    try{
      const rgba=own(cv.matFromImageData(image)),rgb=own(new cv.Mat()),hsv=own(new cv.Mat());
      cv.cvtColor(rgba,rgb,cv.COLOR_RGBA2RGB);cv.cvtColor(rgb,hsv,cv.COLOR_RGB2HSV);
      const raw=own(cv.Mat.zeros(height,width,cv.CV_8UC1)),part=own(new cv.Mat());
      const color=COLORS.find(c=>c.id===colorId);if(!color)throw new Error('알 수 없는 목표 색상');
      const ranges=colorId==='black'?[[[0,0,0],[179,255,56]],[[0,0,57],[179,128,102]]]:colorId==='white'?[[[0,0,199],[179,45,255]]]:color.ranges.map(([start,end])=>[[Math.ceil(start/2),64,46],[Math.min(179,Math.ceil(end/2)-1),255,255]]);
      for(const [low,high]of ranges){
        const lower=new cv.Mat(height,width,cv.CV_8UC3,new cv.Scalar(...low));
        const upper=new cv.Mat(height,width,cv.CV_8UC3,new cv.Scalar(...high));
        try{cv.inRange(hsv,lower,upper,part);cv.bitwise_or(raw,part,raw);}finally{lower.delete();upper.delete();}
      }
      const left=Math.ceil(width*.35-.5),right=Math.ceil(width*.65-.5),top=Math.ceil(height*.35-.5),bottom=Math.ceil(height*.65-.5);
      const roi=new cv.Rect(left,top,right-left,bottom-top),roiArea=(right-left)*(bottom-top);
      const rawRoi=own(raw.roi(roi));const rawCoverage=cv.countNonZero(rawRoi)/roiArea;
      const restricted=own(raw.clone());
      const kernel=own(cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(3,3))),cleaned=own(new cv.Mat());
      cv.morphologyEx(restricted,cleaned,cv.MORPH_OPEN,kernel);
      const closeKernel=colorId==='black'?own(cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(5,5))):kernel;
      cv.morphologyEx(cleaned,cleaned,cv.MORPH_CLOSE,closeKernel);
      // Detect complete color components across the play area. Only their actual
      // pixels inside the central ROI count toward success; hands need not be in it.
      const labels=own(new cv.Mat()),stats=own(new cv.Mat()),centroids=own(new cv.Mat());
      const count=cv.connectedComponentsWithStats(cleaned,labels,stats,centroids,8,cv.CV_32S);
      const roiCounts=new Uint32Array(count);
      // Only actual target-color pixels contribute to 50%; closing-filled holes do not.
      for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){const i=y*width+x;if(raw.data[i])roiCounts[labels.data32S[i]]++;}
      const candidates=[],minimumArea=Math.max(8,Math.ceil(size*.001));
      for(let label=1;label<count;label++){
        const area=stats.intAt(label,cv.CC_STAT_AREA);
        if(area>=minimumArea&&(!searchOnly||roiCounts[label]>0))candidates.push({labelId:label,x:(centroids.doubleAt(label,0)+.5)/width,y:(centroids.doubleAt(label,1)+.5)/height,area,roiArea:roiCounts[label],bounds:{x:stats.intAt(label,cv.CC_STAT_LEFT)/width,y:stats.intAt(label,cv.CC_STAT_TOP)/height,width:stats.intAt(label,cv.CC_STAT_WIDTH)/width,height:stats.intAt(label,cv.CC_STAT_HEIGHT)/height}});
      }
      let selectionContext=handContext;
      if(handContext?.manualPoint){
        const point=handContext.manualPoint,x=Math.floor(point.x*width),y=Math.floor(point.y*height);
        const label=x>=0&&x<width&&y>=0&&y<height?labels.intAt(y,x):0;
        selectionContext={...handContext,manualLabel:label};
      }
      const evaluated=selectionContext?evaluateHeldCandidates(candidates,size,previous,selectionContext):null;
      const selected=evaluated?evaluated.target:candidates.sort((a,b)=>previous?Math.hypot(a.x-previous.x,a.y-previous.y)-Math.hypot(b.x-previous.x,b.y-previous.y)||b.area-a.area:b.area-a.area)[0]??null;
      return {engine:'opencv',coverage:handContext?(selected?.roiArea??0)/roiArea:rawCoverage,rawCoverage,target:selected,candidateCount:candidates.length,candidates:candidates.slice(0,20),reason:evaluated?.reason??(selected?'TRACKED':'NO_COLOR_COMPONENT'),rejectionCounts:evaluated?.rejectionCounts??{},diagnostics:evaluated?.diagnostics??[]};
    }finally{for(const mat of allocated.reverse())mat.delete();}
  }
}
