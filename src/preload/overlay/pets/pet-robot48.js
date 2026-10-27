/**
 * 宠物：机器人 48 号（默认造型）
 * 组成：椭圆头 + 胶囊身 + 屏幕脸（黑底双圆眼）+ 双天线 + 短臂 + 胸口横线
 * 部件类名沿用 lingya-pet-*，template.js 里的五种状态动效自动生效。
 */
module.exports = {
  id: 'robot48',
  name: '机器人 48 号',
  svgLines: [
    '  <svg class="lingya-pet" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
    '    <line class="lingya-pet-wing" x1="27" y1="10" x2="23" y2="4.2" stroke="#2dd4bf" stroke-width="2" stroke-linecap="round"/>',
    '    <line class="lingya-pet-wing" x1="37" y1="10" x2="41" y2="4.2" stroke="#2dd4bf" stroke-width="2" stroke-linecap="round"/>',
    '    <circle cx="22.5" cy="3.3" r="2.2" fill="#2dd4bf"/>',
    '    <circle cx="41.5" cy="3.3" r="2.2" fill="#2dd4bf"/>',
    '    <rect class="lingya-pet-wing" x="15" y="40" width="6" height="11" rx="2.5"/>',
    '    <rect class="lingya-pet-wing" x="43" y="40" width="6" height="11" rx="2.5"/>',
    '    <rect class="lingya-pet-body" x="23" y="35" width="18" height="22" rx="9"/>',
    '    <ellipse class="lingya-pet-head" cx="32" cy="21" rx="14" ry="11.5"/>',
    '    <rect x="21" y="16" width="22" height="12" rx="4" fill="#0a0f14"/>',
    '    <circle class="lingya-pet-eye" cx="27" cy="22" r="2.6"/>',
    '    <circle class="lingya-pet-eye" cx="37" cy="22" r="2.6"/>',
    '    <rect x="27" y="46" width="10" height="2.6" rx="1.3" fill="rgba(45,212,191,0.5)"/>',
    '  </svg>',
  ],
};
