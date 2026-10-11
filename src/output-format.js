const formats = Object.freeze({
  mp4: { badge: 'MP4', detail: '通用视频格式', action: '导出延时视频', download: '下载 MP4 视频', title: '正在生成你的延时视频', realisticTitle: '正在生成写实延时视频', success: '模型生长延时视频已生成。', help: '带背景的视频，适合直接播放和分享。', transparent: false, video: true },
  'mov-alpha': { badge: 'MOV', detail: '透明通道 · ProRes 4444', action: '导出透明通道视频', download: '下载透明 MOV 视频', title: '正在生成透明通道视频', realisticTitle: '正在生成写实透明视频', success: '透明通道模型生长视频已生成，可叠加到剪辑工程。', help: '去除背景，保留模型透明边缘；适合叠加到剪辑工程。', transparent: true, video: true },
  'png-sequence': { badge: 'PNG', detail: '透明图片序列', action: '导出透明图片序列', download: '下载透明图片 ZIP', title: '正在生成透明图片序列', realisticTitle: '正在生成写实图片序列', success: '透明图片序列已打包，可导入剪辑工程。', help: '逐帧透明图片打包为 ZIP，可按图片序列导入。', transparent: true, video: false },
});

export function outputFormat(format) { return formats[format] || formats.mp4; }
