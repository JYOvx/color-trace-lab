// Classic worker: MediaPipe's WASM loader uses importScripts.
let detector;
self.onmessage=async({data})=>{
  if(data.type==='init'){
    try{
      // Relative to this worker so the same files work at / (local) and /<repo>/ (GitHub Pages).
      const base=new URL('../vendor/mediapipe/',self.location.href).href;
      const {FilesetResolver,HandLandmarker}=await import(base+'vision_bundle.mjs');
      const files=await FilesetResolver.forVisionTasks(base+'wasm');
      detector=await HandLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:base+'hand_landmarker.task',delegate:'CPU'},runningMode:'VIDEO',numHands:2,minHandDetectionConfidence:.5,minHandPresenceConfidence:.5,minTrackingConfidence:.5});
      self.postMessage({type:'ready'});
    }catch(error){self.postMessage({type:'error',message:error.message});}
  }else if(data.type==='frame'){
    try{
      const result=detector.detectForVideo(data.bitmap,data.timestamp);
      self.postMessage({type:'hands',landmarks:result.landmarks,timestamp:data.timestamp,crop:data.crop});
    }catch(error){self.postMessage({type:'error',message:error.message});}
    finally{data.bitmap.close();}
  }
};
