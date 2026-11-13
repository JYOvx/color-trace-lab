// All coordinates are normalized to the square play area. No DOM or camera access.
// OpenCV HSV 범위(H 0~179, S·V 0~255). 경계의 밝기와 채도로 비슷한 색을 나눕니다.
export const COLORS = [
  // 팀원 원본의 손·얼굴 오검출을 줄이기 위해 중저명도 빨강의 채도 하한을 높입니다.
  {id:'red', name:'빨강', hex:'#e63946', ranges:[[0,7,120,255,57,199],[0,7,151,255,200,255],[173,179,120,255,57,199],[173,179,151,255,200,255]]},
  {id:'orange', name:'주황', hex:'#f68b29', ranges:[[8,19,64,255,166,255]]},
  {id:'yellow', name:'노랑', hex:'#efc92f', ranges:[[20,34,64,255,57,255]]},
  {id:'green', name:'초록', hex:'#28ad6e', ranges:[[35,49,64,255,57,169],[50,84,64,255,57,255]]},
  {id:'blue', name:'파랑', hex:'#3175e9', ranges:[[85,114,64,255,46,189],[85,114,161,255,190,255],[115,132,64,255,46,255]]},
  {id:'purple', name:'보라', hex:'#9754ce', ranges:[[133,149,64,255,57,255],[150,172,64,255,57,199],[150,172,151,255,200,255]]},
  {id:'black', name:'검정', hex:'#222b3d', ranges:[[0,179,0,255,0,45],[0,179,0,128,46,102]]},
  {id:'white', name:'흰색', hex:'#ffffff', ranges:[[0,179,0,45,199,255]]},
  {id:'pink', name:'분홍', hex:'#ed9fba', ranges:[[150,179,46,150,200,255],[0,7,46,150,200,255]]},
  {id:'lime', name:'연두', hex:'#b4ce72', ranges:[[35,49,64,255,170,255]]},
  {id:'sky', name:'하늘', hex:'#8cc7e2', ranges:[[85,114,46,160,190,255]]},
  {id:'brown', name:'갈색', hex:'#99725a', ranges:[[8,19,64,255,57,165]]},
  {id:'gray', name:'회색', hex:'#a3a4aa', ranges:[[0,179,0,63,103,189],[0,179,0,45,190,198]]},
];
// 어둡고 채도가 낮은 픽셀은 검정에만 넣고 진한 유채색의 어두운 부분은 유지합니다.
for(const color of COLORS){
  if(color.id==='black')continue;
  color.ranges=color.ranges.flatMap(([h0,h1,s0,s1,v0,v1])=>{
    if(v0>102||s0>128)return [[h0,h1,s0,s1,v0,v1]];
    return [[h0,h1,129,s1,v0,102],[h0,h1,s0,s1,103,v1]];
  });
}

export function handsFromLandmarks(landmarks,crop={x:0,y:0,width:1,height:1}) {
  return landmarks.map(fullPoints=>{
    const points=fullPoints.map(point=>({...point,x:(point.x-crop.x)/crop.width,y:(point.y-crop.y)/crop.height}));
    const palm=Math.hypot(points[5].x-points[17].x,points[5].y-points[17].y);
    return {points:points.filter((_,i)=>i!==0),gripPoints:[4,8,12,16,20].map(i=>points[i]),radius:Math.max(.07,Math.min(.22,palm*1.4))};
  });
}

export function selectHeldCandidate(candidates, frameArea, previous, {hands,now,lastHandAt,lastTargetAt}) {
  return evaluateHeldCandidates(candidates,frameArea,previous,{hands,now,lastHandAt,lastTargetAt}).target;
}

export function evaluateHeldCandidates(candidates,frameArea,previous,{hands,now,lastHandAt,lastTargetAt,manualPoint=null,manualLabel=0,manualLock=false}) {
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const locked=previous&&now-lastTargetAt<750;
  const boxDistance=(point,box)=>Math.hypot(Math.max(box.x-point.x,0,point.x-box.x-box.width),Math.max(box.y-point.y,0,point.y-box.y-box.height));
  const overlap=(a,b)=>a&&b&&Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x)&&Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y);
  const diagnostics=candidates.map(candidate=>{
    const contactDistances=hands.map(hand=>Math.min(...(hand.gripPoints??hand.points).map(point=>candidate.bounds?boxDistance(point,candidate.bounds):distance(candidate,point))));
    const contactDistance=Math.min(...contactDistances);
    const nearHand=hands.some((hand,index)=>contactDistances[index]<=Math.min(.12,hand.radius*.65));
    const sameRegion=nearHand&&locked&&overlap(candidate.bounds,previous.bounds);
    let reason='ELIGIBLE';
    if(candidate.area/frameArea>.3)reason='BACKGROUND_SIZED';
    else if(manualPoint&&(!manualLabel||candidate.labelId!==manualLabel))reason='NOT_SELECTED_OBJECT';
    else if(manualLock&&!manualPoint&&!locked)reason='SELECTED_OBJECT_LOST';
    else if(locked&&distance(candidate,previous)>(sameRegion ? .25 : .18))reason='POSITION_JUMP';
    else if(locked&&(candidate.area/previous.area>(sameRegion?6:3)||candidate.area/previous.area<(sameRegion?1/6:.25)))reason='SIZE_CHANGE';
    else if(!manualPoint&&!manualLock&&hands.length&&!nearHand)reason='HAND_TOO_FAR';
    else if(!manualPoint&&!manualLock&&!hands.length&&!(locked&&now-lastHandAt<=300&&distance(candidate,previous)<=.08))reason='NO_HAND';
    return {candidate,reason,contactDistance};
  });
  const plausible=diagnostics.filter(d=>d.reason==='ELIGIBLE');
  plausible.sort((a,b)=>previous&&locked ? distance(a.candidate,previous)-distance(b.candidate,previous)||b.candidate.area-a.candidate.area : a.contactDistance-b.contactDistance||b.candidate.area-a.candidate.area);
  const target=plausible[0]?.candidate??null;
  const rejectionCounts={};for(const d of diagnostics)if(d.reason!=='ELIGIBLE')rejectionCounts[d.reason]=(rejectionCounts[d.reason]??0)+1;
  const reason=target?'TRACKED':!candidates.length?'NO_COLOR_COMPONENT':Object.entries(rejectionCounts).sort((a,b)=>b[1]-a[1])[0]?.[0]??'NO_ELIGIBLE_TARGET';
  return {target,reason,rejectionCounts,diagnostics:diagnostics.slice(0,20).map((d,index)=>({candidateIndex:index,reason:d.reason}))};
}

// 색상 찾기 성공 기준: 중앙 상자 안 목표색 비율. 확정 규칙은 50%였으나 테스트에서 높다는 사용자 판단으로 30%(2026-11-06).
export const SUCCESS_COVERAGE=.3;
export class ColorHold {
  constructor(){this.reset();}
  reset(){this.since=null;this.last=null;this.success=false;}
  update(coverage, now) {
    if(this.success) return {success:true,progress:1};
    if(this.last!==null&&(now-this.last>250||now<this.last)) this.since=null;
    this.last=now;
    if(coverage<SUCCESS_COVERAGE){this.since=null;return {success:false,progress:0};}
    if(this.since===null) this.since=now;
    const progress=Math.min(1,(now-this.since)/500);
    this.success=progress>=1;
    return {success:this.success,progress};
  }
}
