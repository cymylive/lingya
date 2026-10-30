/**
 * preset-store 单元测试
 * 覆盖：新增/更新/列出/重命名/删除、参数校验、落盘与重载
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPresetStore } = require('../../src/main/preset-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-preset-'));
}

function samplePanels() {
  return [
    { profileId: 'p1', profileName: 'A', providerId: 'deepseek', title: 'A 会话', url: 'https://chat.deepseek.com/a' },
    { profileId: 'p2', profileName: 'B', providerId: 'deepseek', title: 'B 会话', url: 'https://chat.deepseek.com/b' },
  ];
}

test('初始状态为空列表', () => {
  const store = createPresetStore(tmpDir());
  assert.deepStrictEqual(store.list(), []);
});

test('save 新建预设并返回完整对象', () => {
  const store = createPresetStore(tmpDir());
  const r = store.save({ name: '三栏布局', direction: 'horizontal', panels: samplePanels() });
  assert.strictEqual(r.ok, true);
  assert.ok(r.preset.id.startsWith('preset-'));
  assert.strictEqual(r.preset.name, '三栏布局');
  assert.strictEqual(r.preset.direction, 'horizontal');
  assert.strictEqual(r.preset.panels.length, 2);
  assert.ok(r.preset.createdAt);
  assert.strictEqual(store.list().length, 1);
});

test('面板不足 2 个时拒绝保存', () => {
  const store = createPresetStore(tmpDir());
  const r = store.save({ name: 'x', direction: 'horizontal', panels: [samplePanels()[0]] });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /至少需要 2 个面板/);
});

test('面板缺 profileId 时拒绝保存', () => {
  const store = createPresetStore(tmpDir());
  const panels = samplePanels();
  panels[1].profileId = '';
  const r = store.save({ name: 'x', direction: 'horizontal', panels });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /profileId/);
});

test('非法方向归一化为 horizontal', () => {
  const store = createPresetStore(tmpDir());
  const r = store.save({ name: 'x', direction: 'whatever', panels: samplePanels() });
  assert.strictEqual(r.preset.direction, 'horizontal');
});

test('vertical 方向被保留', () => {
  const store = createPresetStore(tmpDir());
  const r = store.save({ name: 'x', direction: 'vertical', panels: samplePanels() });
  assert.strictEqual(r.preset.direction, 'vertical');
});

test('不传名称时生成默认名称', () => {
  const store = createPresetStore(tmpDir());
  const r = store.save({ direction: 'horizontal', panels: samplePanels() });
  assert.ok(r.preset.name.startsWith('预设 '));
});

test('传 id 时覆盖更新并保留 createdAt', () => {
  const store = createPresetStore(tmpDir());
  const created = store.save({ name: '旧名', direction: 'horizontal', panels: samplePanels() }).preset;
  const updated = store.save({ name: '新名', direction: 'vertical', panels: samplePanels() }, created.id);
  assert.strictEqual(updated.ok, true);
  assert.strictEqual(updated.preset.id, created.id);
  assert.strictEqual(updated.preset.name, '新名');
  assert.strictEqual(updated.preset.direction, 'vertical');
  assert.strictEqual(updated.preset.createdAt, created.createdAt);
  assert.strictEqual(store.list().length, 1);
});

test('更新不存在的 id 返回错误', () => {
  const store = createPresetStore(tmpDir());
  const r = store.save({ name: 'x', direction: 'horizontal', panels: samplePanels() }, 'preset-nope');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /不存在/);
});

test('rename 修改名称', () => {
  const store = createPresetStore(tmpDir());
  const p = store.save({ name: '旧', direction: 'horizontal', panels: samplePanels() }).preset;
  assert.strictEqual(store.rename(p.id, '新').ok, true);
  assert.strictEqual(store.get(p.id).name, '新');
});

test('rename 空名称被拒绝', () => {
  const store = createPresetStore(tmpDir());
  const p = store.save({ name: '旧', direction: 'horizontal', panels: samplePanels() }).preset;
  assert.strictEqual(store.rename(p.id, '   ').ok, false);
});

test('rename 不存在的 id 返回错误', () => {
  const store = createPresetStore(tmpDir());
  assert.strictEqual(store.rename('preset-nope', 'x').ok, false);
});

test('remove 删除预设', () => {
  const store = createPresetStore(tmpDir());
  const p = store.save({ name: 'x', direction: 'horizontal', panels: samplePanels() }).preset;
  assert.strictEqual(store.remove(p.id).ok, true);
  assert.strictEqual(store.get(p.id), null);
  assert.strictEqual(store.list().length, 0);
});

test('remove 不存在的 id 返回错误', () => {
  const store = createPresetStore(tmpDir());
  assert.strictEqual(store.remove('preset-nope').ok, false);
});

test('list 返回副本，外部修改不影响内部状态', () => {
  const store = createPresetStore(tmpDir());
  store.save({ name: 'x', direction: 'horizontal', panels: samplePanels() });
  const a = store.list();
  a[0].name = '被篡改';
  a[0].panels[0].profileId = 'hacked';
  assert.strictEqual(store.list()[0].name, 'x');
  assert.strictEqual(store.list()[0].panels[0].profileId, 'p1');
});

test('flush 后重新加载能读到数据', () => {
  const dir = tmpDir();
  const s1 = createPresetStore(dir);
  const p = s1.save({ name: '持久化', direction: 'vertical', panels: samplePanels() }).preset;
  assert.strictEqual(s1.flush(), true);

  const s2 = createPresetStore(dir);
  const loaded = s2.get(p.id);
  assert.ok(loaded);
  assert.strictEqual(loaded.name, '持久化');
  assert.strictEqual(loaded.direction, 'vertical');
  assert.strictEqual(loaded.panels.length, 2);
});

test('配置文件损坏时降级为空列表', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'lingya-presets.json'), '{不是合法 JSON', 'utf-8');
  const store = createPresetStore(dir);
  assert.deepStrictEqual(store.list(), []);
});
