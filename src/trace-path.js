// 한붓그리기 판정: 확정 규칙(outputs/color-trace/docs/confirmed-game-rules.md)의 기본값을 따릅니다.
// 좌표는 플레이 영역 정규화 좌표(0~1, 좌우 반전 전). DOM·카메라 접근 없음.
export const PASS_RADIUS=.06, SAMPLE_STEP=.005, FULL_SCORE_DIST=.01, ZERO_SCORE_DIST=.08;
// 삼각형 크기는 규칙에 없어 정한 값: 한 변이 영역 폭의 60%인 정삼각형, 아래 변 높이 78%.
const SIDE=.6, BASE_Y=.78;
export function trianglePath(startOnLeftOfScreen=true,mirrored=true){
  const left={x:.5-SIDE/2,y:BASE_Y},right={x:.5+SIDE/2,y:BASE_Y},top={x:.5,y:BASE_Y-SIDE*Math.sqrt(3)/2};
  // 화면에서 왼쪽 아래가 시작점: 좌우 반전 화면이면 원본 좌표에서는 오른쪽 꼭짓점입니다.
  const start=(startOnLeftOfScreen!==mirrored)?left:right,other=start===left?right:left;
  return {start,vertices:[start,other,top]};
}
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y}),lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
export function distToSegment(p,a,b){
  const ab=sub(b,a),len2=ab.x*ab.x+ab.y*ab.y;
  const t=len2?Math.max(0,Math.min(1,((p.x-a.x)*ab.x+(p.y-a.y)*ab.y)/len2)):0;
  const q=lerp(a,b,t);return Math.hypot(p.x-q.x,p.y-q.y);
}
// 각 변을 4등분한 확인 지점 12개. 마지막은 시작점(끝점).
export function checkpoints(vertices,direction){
  const [s,a,b]=vertices,order=direction==='a-first'?[s,a,b,s]:[s,b,a,s],points=[];
  for(let i=0;i<3;i++)for(const t of [.25,.5,.75,1])points.push(lerp(order[i],order[i+1],t));
  return points;
}
// 선분 a→b가 점 p의 반경 안을 지나면, 선분 위 가장 가까운 지점의 비율(0~1)을 돌려줍니다.
function passAt(a,b,p){
  const ab=sub(b,a),len2=ab.x*ab.x+ab.y*ab.y;
  const t=len2?Math.max(0,Math.min(1,((p.x-a.x)*ab.x+(p.y-a.y)*ab.y)/len2)):0;
  const q=lerp(a,b,t);return Math.hypot(p.x-q.x,p.y-q.y)<=PASS_RADIUS?t:null;
}
export function scoreAccuracy(points,vertices){
  if(points.length<2)return null;
  const edges=[[vertices[0],vertices[1]],[vertices[1],vertices[2]],[vertices[2],vertices[0]]];
  const score=p=>{const d=Math.min(...edges.map(([a,b])=>distToSegment(p,a,b)));return d<=FULL_SCORE_DIST?100:d>=ZERO_SCORE_DIST?0:100*(ZERO_SCORE_DIST-d)/(ZERO_SCORE_DIST-FULL_SCORE_DIST);};
  // 이동 거리 기준으로 0.5% 간격 재표본화: 멈춰 있던 시간·프레임 수가 점수를 바꾸지 않습니다.
  let total=0,count=0,carry=0;
  const add=p=>{total+=score(p);count++;};
  add(points[0]);
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],len=Math.hypot(b.x-a.x,b.y-a.y);
    let d=SAMPLE_STEP-carry;
    while(d<=len){add(lerp(a,b,d/len));d+=SAMPLE_STEP;}
    carry=len-(d-SAMPLE_STEP);
  }
  return total/count;
}
export function createTraceJudge(vertices){
  const routes={'a-first':checkpoints(vertices,'a-first'),'b-first':checkpoints(vertices,'b-first')};
  const start=vertices[0];
  let started=false,direction=null,next=0,last=null,complete=false;
  const points=[],restoredSegments=[];
  function add(p,{restored=false}={}){
    if(complete)return state();
    if(!started){
      // 시작점에 들어오기 전 이동은 평가하지 않습니다.
      if(last&&passAt(last,p,start)!==null||Math.hypot(p.x-start.x,p.y-start.y)<=PASS_RADIUS){started=true;points.push(p);}
      last=p;return state();
    }
    const a=points.at(-1);points.push(p);if(restored)restoredSegments.push(points.length-1);
    if(!direction){
      const ta=passAt(a,p,routes['a-first'][0]),tb=passAt(a,p,routes['b-first'][0]);
      if(ta!==null||tb!==null)direction=tb===null||(ta!==null&&ta<=tb)?'a-first':'b-first';
    }
    if(direction){
      // 한 선분이 여러 확인 지점을 지나면 순서대로 모두 통과 처리합니다(역행은 진행을 되돌리지 않음).
      const route=routes[direction];
      while(next<route.length&&passAt(a,p,route[next])!==null)next++;
      complete=next===route.length;
    }
    last=p;return state();
  }
  function state(){return {started,direction,passed:next,total:12,progress:next/12,complete,accuracy:scoreAccuracy(points,vertices),points,restoredSegments};}
  return {add,state};
}
