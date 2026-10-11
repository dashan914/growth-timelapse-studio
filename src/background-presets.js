// Exact project images. Photography dimensions define an editable virtual
// scene scale; they are not measurements of a real table or a printer bed.
const photographyPlacement = (yawDeg, maxHeight, maxWidth, footY) => Object.freeze({
  revision: 1, yawDeg, centerX: .5, footY, maxHeight, maxWidth,
  reference: '测试2.3mf',
});
const printerPlacement = (x,y) => Object.freeze({
  revision:5,relativeYawDeg:30,maxHeight:.40,maxWidth:.52,plateFill:.90,screenMargin:.035,bottomLimit:.90,
  patternCenter:Object.freeze({x:x/3776,y:y/2832}),
  reference:'测试2.3mf',
});
export const BACKGROUND_PRESETS = Object.freeze({
  h2c: Object.freeze({label:'H2C',url:'/assets/backgrounds/h2c.jpg',mime:'image/jpeg',extension:'jpg',width:330,depth:320,kind:'printer',placement:printerPlacement(1900,1740)}),
  p1s: Object.freeze({label:'P1S',url:'/assets/backgrounds/p1s.jpg',mime:'image/jpeg',extension:'jpg',width:256,depth:256,kind:'printer',placement:printerPlacement(2080,1975)}),
  a1: Object.freeze({label:'A1',url:'/assets/backgrounds/a1.jpg',mime:'image/jpeg',extension:'jpg',width:256,depth:256,kind:'printer',placement:printerPlacement(1970,1740)}),
  'pastel-rug': Object.freeze({label:'彩绒台面',url:'/assets/backgrounds/pastel-rug.png',mime:'image/png',extension:'png',width:180,depth:140,kind:'photography',placement:photographyPlacement(40,.54,.74,.86)}),
  'blue-grey': Object.freeze({label:'蓝灰摄影棚',url:'/assets/backgrounds/blue-grey.png',mime:'image/png',extension:'png',width:180,depth:140,kind:'photography',placement:photographyPlacement(35,.55,.74,.85)}),
  'teal-room': Object.freeze({label:'青绿室内',url:'/assets/backgrounds/teal-room.png',mime:'image/png',extension:'png',width:180,depth:140,kind:'photography',placement:photographyPlacement(60,.52,.72,.86)}),
});

export function isPresetPhotoIdentity(identity) {
  return typeof identity==='string' && identity.startsWith('preset:') && Object.hasOwn(BACKGROUND_PRESETS,identity.slice(7));
}
