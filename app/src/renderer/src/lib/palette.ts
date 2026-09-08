/**
 * 正文可用的颜色。刻意收窄成一小组：颜色在笔记里是用来分类和强调的，
 * 给太多选择只会让文档花掉。
 *
 * 文字色取的是中间调——同一篇笔记会在亮色和暗色下被打开，太深或太浅
 * 都会在某一侧糊掉。想要纯黑纯白，用色板里的「默认」清掉颜色即可。
 */
export const TEXT_COLORS = [
  { label: '灰', value: '#8a8d94' },
  { label: '红', value: '#d1554a' },
  { label: '橙', value: '#c9822e' },
  { label: '黄', value: '#b99a24' },
  { label: '绿', value: '#3d9968' },
  { label: '青', value: '#2a9d94' },
  { label: '蓝', value: '#4a8fd4' },
  { label: '紫', value: '#9b6fd0' },
]

export const HIGHLIGHTS = [
  { label: '黄', value: '#fbe89a' },
  { label: '绿', value: '#c5e8c8' },
  { label: '蓝', value: '#c3ddf5' },
  { label: '粉', value: '#f8ccd8' },
  { label: '紫', value: '#dfd0f2' },
  { label: '灰', value: '#dfe1e4' },
]
