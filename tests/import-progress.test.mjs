import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseHTML} from '../vendor/test-dom/worker.mjs';
import {createImportProgressUI} from '../src/import-progress.js';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
function fixture(onCancel=()=>{}){
  const {document,window}=parseHTML(html);
  const ui=createImportProgressUI({document,onCancel});
  return {document,window,ui,get:id=>document.getElementById(id)};
}

test('import entry accepts one original 3MF or STL for local Bambu slicing and keeps obsolete controls hidden',()=>{
  const {document,get}=fixture();
  assert.equal(get('model-input').getAttribute('accept'),'.3mf,.stl');
  assert.equal(get('model-input').hasAttribute('multiple'),false);
  assert.match(get('import-button').textContent,/导入模型/);
  assert.equal(get('model-name').textContent,'尚未导入模型');
  assert.equal(get('model-type').textContent,'选择 3MF 或 STL');
  for(const id of ['generate-supports','import-supports','support-input','demo-button'])assert.equal(get(id).hidden,true);
  assert.match(get('help-dialog').textContent,/自动检测本机已安装的 Bambu Studio/);
  assert.equal(get('slice-engine'),null,'installed engine detection does not ask the user to choose software');
  assert.match(get('detected-slicer').textContent,/自动检测本机切片器/);
  assert.match(get('help-dialog').textContent,/原始模型网格的 3MF 或 STL/);
  assert.match(get('help-dialog').textContent,/只有打印路径、没有模型网格的文件不能重新切片/);
  assert.equal(document.querySelectorAll('#import-progress').length,1);
});

test('main importer keeps automatic local detection without a software selector or deferred WASM/license entry points',()=>{
  const {document}=fixture();
  assert.equal(document.querySelector('#slice-engine'),null);
  assert.equal(document.querySelector('#license-button'),null);
  assert.equal(document.querySelector('#license-dialog'),null);
  assert.doesNotMatch(app,/from\s*['"][^'"]*(?:embedded-slice-client|license-ui)[^'"]*['"]/);
  assert.doesNotMatch(app,/\b(?:sliceModelInBrowser|createLicenseUI|loadSlicedThreeMF)\s*\(/);
});

test('unmeasured phases remain indeterminate; real worker ratios and counts are displayed per stage',()=>{
  const {ui,get}=fixture();
  ui.begin('宫殿.3mf');
  assert.equal(get('import-progress').hidden,false);
  assert.equal(get('import-progress').getAttribute('aria-busy'),'true');
  assert.equal(get('import-progress').getAttribute('role'),'status');
  assert.equal(get('import-progress').getAttribute('aria-live'),'polite');
  assert.equal(get('import-meter').hasAttribute('value'),false);
  assert.equal(get('import-percent').hidden,true);
  assert.match(get('import-message').textContent,/宫殿\.3mf/);
  ui.update({phase:'parse',progress:.5,message:'正在还原原始路径…'});
  assert.equal(get('import-percent').textContent,'50%');
  assert.equal(get('import-meter').getAttribute('value'),'0.5');
  assert.equal(get('import-meter').getAttribute('aria-label'),'解析打印路径进度');
  ui.update({phase:'index'});
  assert.equal(get('import-phase').textContent,'建立层索引');
  assert.equal(get('import-meter').hasAttribute('value'),false);
  assert.equal(get('import-percent').hidden,true);
  ui.update({phase:'read',completed:512,total:2048});
  assert.equal(get('import-percent').textContent,'25%');
  ui.update({phase:'model',progress:.999});
  assert.equal(get('import-percent').textContent,'99%');
  ui.update({phase:'render',progress:1});
  assert.equal(get('import-percent').textContent,'100%');
  for(const progress of [NaN,Infinity,-1,1.01,'0.5',null]){
    ui.update({phase:'extract',progress});
    assert.equal(get('import-meter').hasAttribute('value'),false);
    assert.equal(get('import-percent').hidden,true);
  }
  ui.update({phase:'parse',completed:5,total:0});
  assert.equal(get('import-meter').hasAttribute('value'),false);
  ui.update({phase:'parse',completed:9,total:4});
  assert.equal(get('import-meter').hasAttribute('value'),false);
});

test('cancellation is available while busy and becomes disabled after requesting once',()=>{
  let calls=0;
  const {ui,get,window}=fixture(()=>calls++);
  assert.equal(ui.cancelEnabled,false);
  ui.begin('大工程.3mf');
  assert.equal(ui.cancelEnabled,true);
  assert.equal(get('cancel-import').disabled,false);
  get('cancel-import').dispatchEvent(new window.Event('click'));
  assert.equal(calls,1);
  assert.equal(get('import-progress').dataset.state,'canceling');
  assert.equal(get('import-phase').textContent,'正在取消导入');
  assert.equal(ui.cancelEnabled,false);
  assert.equal(get('cancel-import').disabled,true);
  get('cancel-import').dispatchEvent(new window.Event('click'));
  ui.update({phase:'render',progress:1});
  assert.equal(calls,1);
  assert.equal(get('import-phase').textContent,'正在取消导入');
  ui.cancelled();
  assert.equal(get('import-progress').dataset.state,'cancelled');
  assert.equal(get('import-progress').getAttribute('aria-busy'),'false');
  assert.equal(get('import-phase').textContent,'已取消导入');
  assert.equal(get('import-message').textContent,'已取消切片，原项目已保留。');
  assert.equal(get('import-meter').hidden,true);
  assert.equal(get('cancel-import').hidden,true);
  assert.equal(ui.cancelEnabled,false);
  ui.begin('取消后重新选择.3mf');
  assert.equal(get('import-progress').dataset.state,'loading');
  assert.equal(ui.cancelEnabled,true);
  assert.equal(get('cancel-import').disabled,false);
  ui.reset();
  assert.equal(ui.cancelEnabled,false);
  assert.equal(get('import-progress').hidden,true);
  assert.equal(get('import-progress').getAttribute('aria-busy'),'false');
});

test('actual sliced-3MF worker phases remain informative and source completion keeps preview loading cancellable',()=>{
  const {ui,get}=fixture();ui.begin('真实工程.3mf');
  for(const [phase,label] of [['reading','读取文件'],['directory','检查切片工程'],['unpacking','提取打印路径'],['hashing','核对原始文件']]){
    ui.update({phase,completed:1,total:2});
    assert.equal(get('import-phase').textContent,label);
    assert.equal(get('import-percent').textContent,'50%');
    assert.equal(get('import-progress').getAttribute('aria-busy'),'true');
  }
  ui.update({phase:'complete',completed:1,total:1});
  assert.equal(get('import-phase').textContent,'切片数据已就绪');
  assert.equal(get('import-progress').dataset.state,'loading');
  assert.equal(ui.cancelEnabled,true);
  ui.update({phase:'configuration',progress:.8});
  assert.equal(get('import-phase').textContent,'读取切片参数');
  assert.equal(get('import-meter').hasAttribute('value'),false);
  assert.equal(get('import-percent').hidden,true);
  ui.update({phase:'cad-preview'});
  assert.equal(get('import-phase').textContent,'准备模型预览');
  assert.equal(get('import-meter').hasAttribute('value'),false);
  assert.equal(get('import-meter').getAttribute('aria-label'),'准备模型预览进度');
  ui.update({phase:'model'});
  assert.equal(get('import-phase').textContent,'载入模型');
  assert.equal(get('import-percent').hidden,true);
});

test('completion and inline errors stop busy state; another file can immediately retry',()=>{
  const {ui,get}=fixture();
  ui.begin('<img src=x onerror=alert(1)>.3mf');
  assert.equal(get('import-message').children.length,0);
  ui.fail('这个 3MF 不含打印路径，请在切片软件中重新导出。');
  assert.equal(get('import-progress').dataset.state,'error');
  assert.equal(get('import-progress').getAttribute('aria-busy'),'false');
  assert.equal(get('import-message').textContent,'这个 3MF 不含打印路径，请在切片软件中重新导出。');
  assert.equal(get('model-input').getAttribute('aria-describedby'),'import-message');
  assert.equal(get('cancel-import').hidden,true);
  assert.equal(get('import-meter').hidden,true);
  ui.update({phase:'render',progress:1});
  assert.equal(get('import-progress').dataset.state,'error');
  ui.begin('另一个已切片工程.3mf');
  assert.equal(get('import-progress').dataset.state,'loading');
  assert.equal(get('cancel-import').disabled,false);
  ui.complete('已导入，原始打印路径已就绪。');
  assert.equal(get('import-progress').dataset.state,'complete');
  assert.equal(get('import-progress').getAttribute('aria-busy'),'false');
  assert.equal(get('import-phase').textContent,'导入完成');
  assert.equal(get('import-percent').hidden,true);
  assert.equal(ui.cancelEnabled,false);
});

test('dispose removes the event listener and ignores later worker updates',()=>{
  let calls=0;
  const {ui,get,window}=fixture(()=>calls++);
  ui.begin('已切片.3mf');
  ui.dispose();ui.dispose();
  get('cancel-import').dispatchEvent(new window.Event('click'));
  ui.begin('不能重新打开.3mf');ui.update({phase:'parse',progress:.2});ui.fail('过时错误');
  assert.equal(calls,0);
  assert.equal(get('import-progress').hidden,true);
  assert.equal(ui.cancelEnabled,false);
});
