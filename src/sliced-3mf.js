import { Inflate, zipSync } from '../node_modules/three/examples/jsm/libs/fflate.module.js';
import { parsePrintLayerGCode } from './print-layer.js';

export const SLICED_3MF_LIMITS = Object.freeze({ archiveBytes: 768 * 1024 * 1024, expandedBytes: 768 * 1024 * 1024, entries: 10000, segments: 10_000_000 });
const utf8 = () => new TextDecoder('utf-8', { fatal: true });
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function checkAbort(signal) { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); }
function emit(onProgress, phase, completed = null, total = null, unit = null, extra = {}) {
  onProgress?.({ phase, completed, total, unit, progress: total > 0 && completed !== null ? Math.min(1, completed / total) : null, ...extra });
}
function limitsFor(overrides = {}) {
  return Object.fromEntries(Object.entries(SLICED_3MF_LIMITS).map(([key, maximum]) => {
    const value = overrides[key] ?? maximum;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw failure('SLICED_3MF_LIMIT', '切片读取预算无效，不能放宽完整数据处理上限。');
    return [key, value];
  }));
}
export function validateSlicedThreeMFFile(file, limits = SLICED_3MF_LIMITS) {
  if (!file || Array.isArray(file) || typeof file.arrayBuffer !== 'function' || typeof file.name !== 'string' || !/\.3mf$/i.test(file.name)) throw failure('SLICED_3MF_REQUIRED', '请选择一个切片后导出的 3MF 文件；其他模型格式不会重新切片。');
  if (!Number.isSafeInteger(file.size) || file.size < 22 || file.size > limits.archiveBytes) throw failure('SLICED_3MF_TOO_LARGE', '切片后 3MF 大小无效或超过 768 MiB 读取预算，原项目已保留。');
}
function safePath(name) {
  if (!name || /^[\/\\]|^[a-z]:/i.test(name) || /[\\\x00-\x1f]/.test(name)) throw failure('SLICED_3MF_UNSAFE_ARCHIVE', '3MF 包含不安全的 ZIP 文件路径。');
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw failure('SLICED_3MF_UNSAFE_ARCHIVE', '3MF 包含越界或含糊的 ZIP 文件路径。');
}
function safe64(view, offset) {
  const value = view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 4294967296;
  if (!Number.isSafeInteger(value)) throw failure('SLICED_3MF_BAD_ZIP', 'ZIP64 数据大小或偏移无法安全读取。');
  return value;
}
/** Inspect before inflation; selected entries cannot hide a ZIP bomb, duplicate
 * path, encrypted member or a different plate. All sizes include ignored assets. */
function directory(bytes, limits, onProgress) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = () => { throw failure('SLICED_3MF_BAD_ZIP', '切片 3MF 的 ZIP 结构损坏，未采用任何部分路径。'); };
  if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50) bad();
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) bad();
  let count = view.getUint16(end + 10, true), diskCount = view.getUint16(end + 8, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (count === 65535 || start === 0xffffffff || size === 0xffffffff) {
    const locator = end - 20;
    if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50 || view.getUint32(locator + 4, true) || view.getUint32(locator + 16, true) !== 1) bad();
    const zip64 = safe64(view, locator + 8);
    if (zip64 + 56 > locator || view.getUint32(zip64, true) !== 0x06064b50 || view.getUint32(zip64 + 16, true) || view.getUint32(zip64 + 20, true)) bad();
    diskCount = safe64(view, zip64 + 24); count = safe64(view, zip64 + 32); size = safe64(view, zip64 + 40); start = safe64(view, zip64 + 48);
  }
  if (!count || count !== diskCount || count > limits.entries || start + size > end) bad();
  const entries = [], names = new Set(), ranges = [];
  let at = start, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > start + size || view.getUint32(at, true) !== 0x02014b50) bad();
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true), crc = view.getUint32(at + 16, true);
    let compressed = view.getUint32(at + 20, true), original = view.getUint32(at + 24, true), offset = view.getUint32(at + 42, true);
    const nameLength = view.getUint16(at + 28, true), extraLength = view.getUint16(at + 30, true), commentLength = view.getUint16(at + 32, true);
    if (at + 46 + nameLength + extraLength + commentLength > start + size || flags & 0x41 || ![0, 8].includes(method) || view.getUint16(at + 34, true)) bad();
    if ((view.getUint32(at + 38, true) >>> 16 & 0xf000) === 0xa000) throw failure('SLICED_3MF_UNSAFE_ARCHIVE', '3MF 不能包含符号链接。');
    let name; try { name = utf8().decode(bytes.subarray(at + 46, at + 46 + nameLength)); } catch { throw failure('SLICED_3MF_BAD_ZIP', 'ZIP 文件名不是可安全读取的 UTF-8。'); }
    safePath(name);
    if (names.has(name.toLowerCase())) throw failure('SLICED_3MF_UNSAFE_ARCHIVE', '3MF 包含重复或仅大小写不同的 ZIP 路径。');
    names.add(name.toLowerCase());
    let extra = at + 46 + nameLength, extraEnd = extra + extraLength, zip64Found = false;
    while (extra + 4 <= extraEnd) {
      const type = view.getUint16(extra, true), length = view.getUint16(extra + 2, true), value = extra + 4;
      if (value + length > extraEnd) bad();
      if (type === 1) {
        let cursor = value;
        for (const field of ['original','compressed','offset']) {
          if ((field === 'original' ? original : field === 'compressed' ? compressed : offset) !== 0xffffffff) continue;
          if (cursor + 8 > value + length) bad();
          const parsed = safe64(view, cursor); cursor += 8;
          if (field === 'original') original = parsed; else if (field === 'compressed') compressed = parsed; else offset = parsed;
        }
        zip64Found = true;
      }
      extra = value + length;
    }
    if ([original, compressed, offset].includes(0xffffffff) || (!zip64Found && ![original, compressed, offset].every(Number.isSafeInteger))) bad();
    expanded += original;
    if (expanded > limits.expandedBytes || original > limits.expandedBytes) throw failure('SLICED_3MF_TOO_LARGE', '3MF 展开后超过 768 MiB 预算，不会截断原路径。');
    if (offset + 30 > start || view.getUint32(offset, true) !== 0x04034b50 || view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method) bad();
    const localNameLength = view.getUint16(offset + 26, true), localExtraLength = view.getUint16(offset + 28, true), dataStart = offset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressed > start || localNameLength !== nameLength) bad();
    const localName = bytes.subarray(offset + 30, offset + 30 + localNameLength), centralName = bytes.subarray(at + 46, at + 46 + nameLength);
    if (localName.some((value, index) => value !== centralName[index])) bad();
    if (!(flags & 8) && (view.getUint32(offset + 14, true) !== crc || ![compressed,0xffffffff].includes(view.getUint32(offset + 18, true)) || ![original,0xffffffff].includes(view.getUint32(offset + 22, true)))) bad();
    ranges.push([offset,dataStart + compressed]);
    entries.push({name, flags, method, crc, original, compressed, dataStart});
    at += 46 + nameLength + extraLength + commentLength;
    emit(onProgress,'directory',index + 1,count,'entries');
  }
  if (at !== start + size) bad();
  ranges.sort((a,b)=>a[0]-b[0]);
  if (ranges.some((range,index)=>index && range[0] < ranges[index-1][1])) bad();
  return { entries, expanded };
}

/** XML presence scanner, not a geometry parser. Comments/CDATA/quoted values
 * never create a false triangle or plate. Large model XML need not become one
 * additional string in memory. Original source models remain in their Blob. */
function xmlScanner() {
  let buffer = '', skip = null, triangles = 0, plates = 0;
  const decoder = utf8();
  return {
    push(bytes, final) {
      try { buffer += decoder.decode(bytes,{stream:!final}); } catch { throw failure('SLICED_3MF_BAD_ZIP','3MF 模型或元数据文本编码损坏。'); }
      while (buffer.length) {
        if (skip) { const at = buffer.indexOf(skip); if (at < 0) { buffer = buffer.slice(-skip.length); break; } buffer = buffer.slice(at + skip.length); skip = null; continue; }
        const opening = buffer.indexOf('<');
        if (opening < 0) { buffer = ''; break; }
        buffer = buffer.slice(opening);
        if (buffer.length < 10 && !final) break;
        if (buffer.startsWith('<!--')) { buffer = buffer.slice(4); skip = '-->'; continue; }
        if (buffer.startsWith('<![CDATA[')) { buffer = buffer.slice(9); skip = ']]>'; continue; }
        if (/^<!\s*(?:DOCTYPE|ENTITY)\b/i.test(buffer)) throw failure('SLICED_3MF_UNSAFE_ARCHIVE','3MF 不支持 XML 实体或外部声明。');
        if (buffer.startsWith('<?')) { buffer = buffer.slice(2); skip = '?>'; continue; }
        let quote = null, end = -1;
        for (let index=1;index<buffer.length;index++) { const value=buffer[index]; if(quote){if(value===quote)quote=null;}else if(value==='"'||value==="'")quote=value;else if(value==='>'){end=index;break;} }
        if (end < 0) { if(buffer.length>65536||final)throw failure('SLICED_3MF_BAD_ZIP','3MF 包含截断或异常长的 XML 标记。');break; }
        const match = buffer.slice(0,end+1).match(/^<([\w.-]+:)?(triangle|plate)(?=\s|\/?>)/i);
        if(match){if(match[2].toLowerCase()==='triangle')triangles++;else plates++;}
        buffer=buffer.slice(end+1);
      }
      if(final&&(skip||buffer.trim()))throw failure('SLICED_3MF_BAD_ZIP','3MF 模型或元数据 XML 不完整。');
    },
    get triangles(){return triangles;},get plates(){return plates;},
  };
}
async function inflateEntry(bytes, entry, { signal, onChunk }) {
  let count=0, crc=0xffffffff;
  const accept = chunk => {
    checkAbort(signal); count += chunk.length;
    if(count>entry.original)throw failure('SLICED_3MF_BAD_ZIP','ZIP 实际展开大小与声明不符。');
    for(let index=0;index<chunk.length;index++)crc=CRC_TABLE[(crc^chunk[index])&255]^crc>>>8;
    onChunk(chunk,count);
  };
  if(entry.method===0){
    if(entry.original!==entry.compressed)throw failure('SLICED_3MF_BAD_ZIP','ZIP 存储成员大小不符。');
    for(let at=0;at<entry.compressed;at+=65536){accept(bytes.subarray(entry.dataStart+at,entry.dataStart+Math.min(at+65536,entry.compressed)));if(at%1048576===0)await tick();}
  }else{
    const inflater=new Inflate((chunk)=>accept(chunk));
    try {
      for(let at=0;at<entry.compressed;at+=16384){const end=Math.min(at+16384,entry.compressed);inflater.push(bytes.subarray(entry.dataStart+at,entry.dataStart+end),end===entry.compressed);if(at%262144===0)await tick();}
    }catch(error){if(error.name==='AbortError'||error.code?.startsWith('SLICED_3MF_'))throw error;throw failure('SLICED_3MF_BAD_ZIP','ZIP 压缩数据损坏，未采用部分切片。');}
  }
  checkAbort(signal);
  if(count!==entry.original||((crc^0xffffffff)>>>0)!==entry.crc)throw failure('SLICED_3MF_BAD_ZIP','ZIP 文件的完整大小或 CRC 校验失败。');
}
async function sha256(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join(''); }

export async function parseSlicedThreeMF(input, { fileName='sliced.3mf', signal, onProgress=()=>{}, limits: requestedLimits={} }={}) {
  checkAbort(signal);
  if(!/\.3mf$/i.test(fileName))throw failure('SLICED_3MF_REQUIRED','仅支持切片后 3MF，不会为其他模型重新计算路径。');
  const limits=limitsFor(requestedLimits), bytes=input instanceof Uint8Array?input:new Uint8Array(input);
  if(bytes.length>limits.archiveBytes)throw failure('SLICED_3MF_TOO_LARGE','3MF 超过完整读取预算。');
  const inspected=directory(bytes,limits,onProgress);
  const binary=inspected.entries.find(entry=>/\.(?:gcode\.bin|bgcode)$/i.test(entry.name));
  if(binary)throw failure('SLICED_3MF_BINARY_UNSUPPORTED','这个 3MF 保存的是暂不支持的二进制切片（.gcode.bin / .bgcode）。请从切片软件导出包含普通文本 G-code 的切片后 3MF；不会重新切片。');
  const candidates=inspected.entries.filter(entry=>/^(?:Metadata\/)?plate_\d+\.gcode$/i.test(entry.name));
  if(candidates.length>1)throw failure('SLICED_3MF_MULTIPLATE','3MF 包含多盘或重复切片，请只导出一个打印盘。不会重新计算路径。');
  if(!candidates.length)throw failure('SLICED_3MF_NO_PATHS','这个文件没有原始切片路径。请先在切片软件完成切片，再导出切片后 3MF；普通工程 3MF 不会在这里重新切片。');
  const selected=candidates[0];
  if(!/^(?:Metadata\/)?plate_1\.gcode$/i.test(selected.name))throw failure('SLICED_3MF_WRONG_PLATE','当前只读取第 1 盘的单盘切片后 3MF，请导出第 1 盘。');
  const gcodeBytes=new Uint8Array(selected.original),previewEntries=Object.create(null),cadPreviewMembers=[];
  let unpacked=0,hasCad=false,modelEntries=0,plateCount=0;
  emit(onProgress,'unpacking',0,inspected.expanded,'bytes');
  for(const entry of inspected.entries){
    checkAbort(signal);
    const isModel=/\.model$/i.test(entry.name),isPlateConfig=/^Metadata\/model_settings\.(?:config|xml)$/i.test(entry.name);
    const scanner=isModel||isPlateConfig?xmlScanner():null;
    const previewBytes=entry===selected?null:new Uint8Array(entry.original);
    await inflateEntry(bytes,entry,{signal,onChunk(chunk,completed){
      if(entry===selected)gcodeBytes.set(chunk,completed-chunk.length);
      else previewBytes.set(chunk,completed-chunk.length);
      scanner?.push(chunk,false);unpacked+=chunk.length;
      emit(onProgress,'unpacking',unpacked,inspected.expanded,'bytes',{archiveEntry:entry.name,entryCompleted:completed,entryTotal:entry.original});
    }});
    scanner?.push(new Uint8Array(),true);
    if(isModel){modelEntries++;hasCad ||= scanner.triangles>0;}
    if(isPlateConfig)plateCount=Math.max(plateCount,scanner.plates);
    if(previewBytes){previewEntries[entry.name]=previewBytes;cadPreviewMembers.push({name:entry.name,bytes:entry.original,crc32:entry.crc});}
  }
  if(plateCount>1)throw failure('SLICED_3MF_MULTIPLATE','工程元数据包含多个打印盘，无法把所有 CAD 和第 1 盘路径混为同一模型。请导出单盘切片后 3MF。');
  checkAbort(signal);
  for(let index=0;index<gcodeBytes.length;index++)if(gcodeBytes[index]<32&&![9,10,13].includes(gcodeBytes[index]))throw failure('SLICED_3MF_BINARY_UNSUPPORTED','原切片文件不是受支持的普通文本 G-code；不会忽略二进制数据或重新切片。');
  let text;try{text=utf8().decode(gcodeBytes);}catch{throw failure('SLICED_3MF_BINARY_UNSUPPORTED','原切片不是完整 UTF-8 文本 G-code，未采用部分路径。');}
  let parsed;
  try{
    parsed=parsePrintLayerGCode(text,{includeSupport:true,maxSegments:limits.segments,maxTextBytes:limits.expandedBytes,onProgress:event=>{
      checkAbort(signal);
      emit(onProgress,event.phase,event.completed,event.total,event.phase==='parse'?'characters':event.phase==='index'?'segments':null,{segmentCount:event.segmentCount});
    }});
  }catch(error){if(error.name==='AbortError')throw error;throw failure('SLICED_3MF_BAD_GCODE',error.message);}
  text=null;checkAbort(signal);
  emit(onProgress,'hashing',0,2,'files');
  const sourceHash=await sha256(bytes);checkAbort(signal);emit(onProgress,'hashing',1,2,'files');
  const gcodeHash=await sha256(gcodeBytes);checkAbort(signal);emit(onProgress,'hashing',2,2,'files');
  const gcodeName=selected.name.split('/').at(-1),gcodeFile=typeof File==='function'?new File([gcodeBytes],gcodeName,{type:'text/plain'}):new Blob([gcodeBytes],{type:'text/plain'});
  let cadPreviewFile=null;
  const cadPreviewFileName=fileName.replace(/\.3mf$/i,'')+'.preview.3mf';
  if(hasCad){
    // This is a separate display container, never the original archive/cache.
    // Every remaining model/metadata/texture member keeps its exact raw bytes;
    // excluding the huge path member prevents CAD loaders unzipping it again.
    emit(onProgress,'cad-preview',null,null,null,{memberCount:cadPreviewMembers.length});
    await tick();checkAbort(signal);
    const preview=zipSync(previewEntries,{level:3});
    cadPreviewFile=typeof File==='function'?new File([preview],cadPreviewFileName,{type:'model/3mf'}):new Blob([preview],{type:'model/3mf'});
  }
  emit(onProgress,'complete',1,1,'result',{segmentCount:parsed.segmentCount});
  return {parsed,gcodeFile,gcodeFileName:gcodeName,cadPreviewFile,cadPreviewFileName,cadPreviewMembers:hasCad?cadPreviewMembers:[],hasCad,pathOnly:!hasCad,archiveEntry:selected.name,sourceHash,gcodeHash,sourceBytes:bytes.length,gcodeBytesLength:gcodeBytes.length,expandedBytes:inspected.expanded,modelEntries,plateCount:1,toolColors:[...parsed.toolColors],usedTools:[...parsed.usedTools],reSliced:false,pathSource:'original-embedded-text-gcode',zipCRCValidated:true,
    colorConfirmationRequired:parsed.usedTools.some(tool=>!/^#[\da-f]{6}$/i.test(parsed.toolColors[tool]||''))};
}

/** Public main-thread entry; the pure parser above is also used by CPU tests. */
export async function loadSlicedThreeMF(file,options={}) { const {loadSlicedThreeMFInWorker}=await import('./sliced-3mf-client.js');return loadSlicedThreeMFInWorker(file,options); }
