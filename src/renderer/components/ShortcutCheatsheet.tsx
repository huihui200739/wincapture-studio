import { Button, Modal } from './ui';

const GROUPS = [
  { title: '播放与浏览', entries: [
    ['空格', '播放 / 暂停；按钮和时间线对象获得焦点时，操作当前对象'],
    ['← / →', '播放头向前 / 向后移动 1 帧'],
    ['Shift + ← / →', '播放头向前 / 向后移动 1 秒'],
    ['Home / End', '播放头定位到开头 / 结尾'],
    ['F', '进入 / 退出专注预览'],
  ] },
  { title: '剪辑与效果', entries: [
    ['Ctrl + B', '在播放头分割时间线片段'],
    ['Delete / Backspace', '删除选中的片段、效果或教程步骤；保留源素材'],
    ['Ctrl + C / V', '复制效果 / 在播放头粘贴效果'],
    ['Ctrl + Shift + V', '向选中的同类效果粘贴属性，保留时间区间'],
    ['右键 / Shift + F10', '打开当前时间线对象的操作菜单；也支持菜单键'],
  ] },
  { title: '时间线与参数', entries: [
    ['片段上的 ← / →', '移动获得焦点的片段，每次 0.5 秒'],
    ['片段上的 Shift + ← / →', '逐帧移动获得焦点的片段'],
    ['Alt + 拖动', '拖动或裁剪时临时跳过吸附'],
    ['Enter / Esc', '数值输入确认 / 取消；旋钮也支持方向键微调'],
    ['双击时间线上沿', '恢复时间线的默认高度'],
    ['Esc', '优先取消当前拖动、关闭菜单或退出专注预览'],
  ] },
  { title: '通用', entries: [
    ['Ctrl + S', '保存工程'],
    ['Ctrl + Z', '撤销'],
    ['Ctrl + Y / Ctrl + Shift + Z', '重做'],
    ['Ctrl + 1 … 6', '依次打开首页、录制、编辑器、导出、教程、设置'],
    ['F1', '打开快捷键速查'],
  ] },
] as const;

export function ShortcutCheatsheet({ onClose }: { onClose: () => void }) {
  return <Modal title="Windows 快捷键速查" className="shortcut-dialog" width={660} onClose={onClose}
    footer={<Button variant="primary" onClick={onClose}>知道了</Button>}>
    <p className="shortcut-intro">按键优先作用于当前控件。输入文字时，剪辑快捷键不会抢走文字输入。</p>
    {GROUPS.map(group => <section className="shortcut-group" key={group.title} aria-label={group.title}>
      <h3>{group.title}</h3>
      <dl>{group.entries.map(([keys, action]) => <div className="shortcut-row" key={keys}>
        <dt><kbd>{keys}</kbd></dt><dd>{action}</dd>
      </div>)}</dl>
    </section>)}
  </Modal>;
}
