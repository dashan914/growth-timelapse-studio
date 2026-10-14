import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { SOURCE_BLOB_LIMIT, validateCachePatch, normalizeFile } from '../src/project-cache.js';

test('partial cache updates retain existing source sizes and explicit clears release them', () => {
  const previous = { modelFiles: 18_000_000, backgroundFile: 3_000_000, referenceFile: 2_000_000, supportGcode: 68_000_000, supportFile:0, customSoundFile:0 };
  const poseUpdate = validateCachePatch({ camera: { yaw: 10 }, backgroundFile: undefined }, previous);
  assert.deepEqual(poseUpdate.sourceBytes, previous);
  assert.equal(poseUpdate.totalSourceBytes, 91_000_000);
  const cleared = validateCachePatch({ modelFiles: [], backgroundFile: null, referenceFile: null, supportGcode: null }, previous);
  assert.equal(cleared.totalSourceBytes, 0);
  assert.equal(previous.supportGcode, 68_000_000, 'validation must not change its input');
});

test('source budget measures all files plus UTF-8 G-code and refuses oversized merged projects', () => {
  const source = new Blob(['1234']);
  const result = validateCachePatch({ modelFiles: [source, source], backgroundFile: source, referenceFile: source, supportGcode: '你好' });
  assert.equal(result.totalSourceBytes, 22);
  assert.equal(validateCachePatch({ settings: { hold: 2 } }, { modelFiles: SOURCE_BLOB_LIMIT }).totalSourceBytes, SOURCE_BLOB_LIMIT);
  assert.throws(() => validateCachePatch({ supportGcode: '1' }, { modelFiles: SOURCE_BLOB_LIMIT }), /512 MiB/);
  assert.throws(() => validateCachePatch({ supportGcode: '1' }, { modelFiles: Infinity }), /512 MiB/);
});

test('complete support source is a retained file under the combined budget, not a simplified text preview',()=>{
  const source=new Blob([';TYPE:Support\nG1 X10 Y20 E1\n']);
  const result=validateCachePatch({supportFile:source},{modelFiles:18_000_000});
  assert.equal(result.sourceBytes.supportFile,source.size);
  assert.equal(validateCachePatch({supportFile:null},result.sourceBytes).sourceBytes.supportFile,0);
  assert.throws(()=>validateCachePatch({supportFile:'G1 X0'}),/文件|照片缓存/);
});

test('invalid file and patch types fail explicitly instead of saving malformed sources', () => {
  for (const patch of [null, [], 'file', { modelFiles: null }, { modelFiles: ['a.stl'] }, { backgroundFile: 'a.jpg' }, { referenceFile: {} }, { supportGcode: new Blob(['G1']) }, { backgroundPreset: 2 }, { camera: [] }, { settings: 2 }, { unexpected: true }]) {
    assert.throws(() => validateCachePatch(patch), TypeError);
  }
  assert.deepEqual(validateCachePatch({ settings: null, camera: null, backgroundPreset: null }).sourceBytes,
    { modelFiles: 0, backgroundFile: 0, referenceFile: 0, supportGcode: 0, supportFile:0, customSoundFile:0 });
});

test('restored Blob keeps the original File import name, type, modification date and contents', async () => {
  const originalFileConstructor = globalThis.File;
  globalThis.File = File;
  try {
    const original = new File(['mesh-data'], '测试.3mf', { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml', lastModified: 123456789 });
    const restored = normalizeFile({ blob: new Blob([original]), name: original.name, type: original.type, lastModified: original.lastModified });
    assert.equal(restored.name, original.name);
    assert.equal(restored.type, original.type);
    assert.equal(restored.lastModified, original.lastModified);
    assert.equal(await restored.text(), 'mesh-data');
    assert.equal(normalizeFile(null), null);
    assert.throws(() => normalizeFile({ blob: 'missing' }), /损坏/);
  } finally {
    if (originalFileConstructor === undefined) delete globalThis.File;
    else globalThis.File = originalFileConstructor;
  }
});

test('generated PNG backgrounds retain their exact preset ID and file metadata through the cache serialization boundary',async()=>{
  const originalFileConstructor=globalThis.File;globalThis.File=File;
  try {
    for(const key of ['pastel-rug','blue-grey','teal-room']) {
      const bytes=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]);
      const original=new File([bytes],key+'.png',{type:'image/png',lastModified:123456789});
      const patch={backgroundPreset:key,backgroundFile:original};
      assert.equal(validateCachePatch(patch).sourceBytes.backgroundFile,bytes.length);
      const stored=structuredClone({backgroundPreset:patch.backgroundPreset,
        backgroundFile:{blob:original,name:original.name,type:original.type,lastModified:original.lastModified}});
      const restored=normalizeFile(stored.backgroundFile);
      assert.equal(stored.backgroundPreset,key);assert.equal(restored.name,key+'.png');
      assert.equal(restored.type,'image/png');assert.equal(restored.lastModified,original.lastModified);
      assert.deepEqual(new Uint8Array(await restored.arrayBuffer()),bytes);
      assert.equal(validateCachePatch({backgroundPreset:stored.backgroundPreset,backgroundFile:restored}).sourceBytes.backgroundFile,bytes.length);
    }
  } finally {
    if(originalFileConstructor===undefined)delete globalThis.File;else globalThis.File=originalFileConstructor;
  }
});

test('custom audio Blob and mode share the project budget and retain import metadata',async()=>{
  const file=new File(['original-audio-bytes'],'自定义.mp3',{type:'audio/mpeg',lastModified:123});
  const patch={customSoundFile:file,soundMode:'custom'};
  assert.equal(validateCachePatch(patch).sourceBytes.customSoundFile,file.size);
  const restored=normalizeFile(structuredClone({blob:file,name:file.name,type:file.type,lastModified:file.lastModified}));
  assert.equal(restored.name,file.name);assert.equal(restored.type,file.type);assert.equal(await restored.text(),'original-audio-bytes');
  assert.equal(validateCachePatch({customSoundFile:null,soundMode:'none'},validateCachePatch(patch).sourceBytes).sourceBytes.customSoundFile,0);
  assert.throws(()=>validateCachePatch({customSoundFile:'base64'}),TypeError);
  assert.throws(()=>validateCachePatch({soundMode:'unknown'}),TypeError);
  assert.throws(()=>validateCachePatch(patch,{modelFiles:SOURCE_BLOB_LIMIT}),/512 MiB/);
});
