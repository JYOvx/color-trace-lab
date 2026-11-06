import {createColorPractice} from './color-practice.js';
const $ = (id) => document.getElementById(id);
let stream = null;
let requestVersion = 0;
let cameraReady = false;
let cancelConnection = null;
const cameraSelect = document.createElement('select');
cameraSelect.id = 'camera-device';
cameraSelect.setAttribute('aria-label', '사용할 카메라');
cameraSelect.add(new Option('기본 카메라', ''));
const cameraLabel = document.createElement('label');
cameraLabel.className = 'camera-device-label';
cameraLabel.append('사용할 카메라 ', cameraSelect);
$('camera-status').before(cameraLabel);
const practice=createColorPractice({video:$('camera'),playArea:$('play-area'),isCameraReady:()=>cameraReady});
let savedName = '';
try { savedName = sessionStorage.getItem('color-trace.nickname') || ''; } catch { /* Storage can be blocked; this tab still works. */ }
$('nickname').value = savedName;
$('nickname-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('nickname').value.trim();
  if (!name || [...name].length > 12) { $('form-error').textContent = '닉네임을 1~12자로 입력해 주세요.'; return; }
  try { sessionStorage.setItem('color-trace.nickname', name); } catch { /* No persistent storage required. */ }
  $('welcome').hidden = true;
  $('lobby').hidden = false;
  $('camera-toggle').focus();
});
function renderReady() {
  practice.updateReady(cameraReady);
}
function stopCamera() {
  practice.stop();
  requestVersion++;
  cancelConnection?.();
  cancelConnection = null;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  cameraReady = false;
  $('camera').srcObject = null;
  $('placeholder').hidden = false;
  $('play-area').hidden = true;
  $('live').hidden = true;
  $('camera-toggle').textContent = '카메라 켜기';
  $('camera-toggle').disabled = false;
  cameraSelect.disabled = false;
  renderReady();
}
function sizePlayArea() {
  const video = $('camera');
  if (!video.videoWidth || !stream) return;
  const stage = video.parentElement;
  const scale = Math.min(stage.clientWidth / video.videoWidth, stage.clientHeight / video.videoHeight);
  const side = Math.min(video.videoWidth, video.videoHeight) * scale * .8;
  Object.assign($('play-area').style, { width: `${side}px`, height: `${side}px`, left: `${(stage.clientWidth-side)/2}px`, top: `${(stage.clientHeight-side)/2}px` });
}
async function refreshCameras(currentId = cameraSelect.value) {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
    cameraSelect.replaceChildren(new Option('기본 카메라', ''));
    devices.forEach((device, index) => cameraSelect.add(new Option(device.label || `카메라 ${index + 1}`, device.deviceId)));
    if ([...cameraSelect.options].some(option => option.value === currentId)) cameraSelect.value = currentId;
  } catch { /* Device listing is optional; keep default camera available. */ }
}
function boundedRequest(promise, signal, timeoutMs, timeoutName, dispose = () => {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new DOMException('연결 취소', 'AbortError'));
    const timer = setTimeout(() => finish(new DOMException('시간 초과', timeoutName)), timeoutMs);
    signal.addEventListener('abort', abort, {once:true});
    if (signal.aborted) abort();
    promise.then(value => done ? dispose(value) : finish(null, value), error => finish(error));
  });
}
function firstVideoFrame(video, signal) {
  return new Promise((resolve, reject) => {
    let callbackId;
    let interval;
    const finish = error => {
      clearTimeout(timer);
      clearInterval(interval);
      if (callbackId !== undefined) video.cancelVideoFrameCallback(callbackId);
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new DOMException('연결 취소', 'AbortError'));
    const timer = setTimeout(() => finish(new DOMException('영상 프레임 없음', 'NoVideoFrameError')), 10000);
    signal.addEventListener('abort', abort, {once:true});
    if (signal.aborted) { abort(); return; }
    if (video.requestVideoFrameCallback) callbackId = video.requestVideoFrameCallback(() => finish());
    else interval = setInterval(() => { if (video.readyState >= 2 && video.videoWidth > 0 && !video.paused) finish(); }, 100);
  });
}
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { $('camera-status').textContent = '카메라를 사용할 수 없습니다. localhost 또는 HTTPS 주소로 접속해 주세요.'; return; }
  const version = ++requestVersion;
  const controller = new AbortController();
  cancelConnection = () => controller.abort();
  cameraSelect.disabled = true;
  $('camera-toggle').textContent = '연결 취소';
  $('camera-status').textContent = '브라우저에서 카메라 사용을 허용해 주세요.';
  try {
    const selectedId = cameraSelect.value;
    const acquired = await boundedRequest(navigator.mediaDevices.getUserMedia({audio:false,video:selectedId ? {deviceId:{exact:selectedId}} : true}), controller.signal, 30000, 'CameraRequestTimeoutError', lateStream => lateStream.getTracks().forEach(track => track.stop()));
    if (version !== requestVersion) { acquired.getTracks().forEach((track) => track.stop()); return; }
    stream = acquired;
    const video = $('camera');
    const track = stream.getVideoTracks()[0];
    if (!track) throw new DOMException('영상 트랙 없음', 'NotFoundError');
    void refreshCameras(track.getSettings().deviceId);
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    $('camera-status').textContent = '카메라가 연결되었습니다. 실제 영상을 기다리고 있어요…';
    await boundedRequest(video.play(), controller.signal, 10000, 'NoVideoFrameError');
    await firstVideoFrame(video, controller.signal);
    if (version !== requestVersion) return;
    cameraReady = true;
    track.addEventListener('ended', () => { if (stream === acquired) { stopCamera(); $('camera-status').textContent = '카메라 연결이 종료되었습니다. 다시 연결해 주세요.'; } });
    $('placeholder').hidden = true;
    $('play-area').hidden = false;
    $('live').hidden = false;
    $('camera-toggle').textContent = '카메라 끄기';
    $('camera-status').textContent = `${track.label || '카메라'} · 영상 수신 중 (${video.videoWidth}×${video.videoHeight}). 영상이 검게 보이면 렌즈 덮개를 확인하거나 다른 카메라를 선택해 주세요.`;
    sizePlayArea();
    renderReady();
  } catch (error) {
    if (version !== requestVersion) return;
    stopCamera();
    void refreshCameras();
    const messages = {NotAllowedError:'카메라 사용이 허용되지 않았습니다. 브라우저의 사이트 권한을 확인하고 다시 눌러 주세요.',NotFoundError:'카메라를 찾지 못했습니다. 연결 상태를 확인해 주세요.',NotReadableError:'카메라를 열 수 없습니다. 다른 앱에서 사용 중인지 확인해 주세요.',OverconstrainedError:'선택한 카메라를 사용할 수 없습니다. 다른 장치를 선택해 주세요.',NoVideoFrameError:'권한은 허용되었지만 영상이 들어오지 않습니다. 사용할 카메라에서 실제 웹캠을 선택한 뒤 다시 켜 주세요. 다른 앱이 카메라를 사용 중인지도 확인해 주세요.',CameraRequestTimeoutError:'카메라 응답이 없습니다. 권한 안내와 장치 연결을 확인한 뒤 다시 켜 주세요.'};
    $('camera-status').textContent = messages[error.name] || '카메라 연결에 실패했습니다. 장치와 브라우저 설정을 확인해 주세요.';
  } finally { if (version === requestVersion) { cancelConnection = null; cameraSelect.disabled = false; } }
}
$('camera-toggle').addEventListener('click', () => {
  if (stream || cancelConnection) { stopCamera(); $('camera-status').textContent = '카메라를 껐습니다. 다른 장치를 선택하거나 다시 켤 수 있어요.'; return; }
  void startCamera();
});
cameraSelect.addEventListener('change', () => {
  const shouldReconnect = !!stream || !!cancelConnection;
  stopCamera();
  if (shouldReconnect) void startCamera();
});
$('mirror').addEventListener('change', () => $('camera').classList.toggle('mirrored', $('mirror').checked));
$('camera').classList.add('mirrored');
$('camera').addEventListener('loadedmetadata', sizePlayArea);
new ResizeObserver(sizePlayArea).observe($('camera').parentElement);
$('leave').addEventListener('click', () => { stopCamera(); $('lobby').hidden = true; $('welcome').hidden = false; $('nickname').focus(); });
$('help').addEventListener('click', () => $('help-dialog').showModal());
$('close-help').addEventListener('click', () => $('help-dialog').close());
window.addEventListener('pagehide', stopCamera);
