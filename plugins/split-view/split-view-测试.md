---
title: 分屏渲染测试
tags: [test, split-view]
---

# 一级标题

## 二级标题

### 三级标题

#### 四级标题

正文段落，包含**加粗**、*斜体*、***粗斜体***、~~删除线~~、`行内代码`，以及一个[外部链接](https://example.com)和一个锚点链接[回到顶部](#一级标题)。

> 324254

---

## 列表

- 无序列表一
- 无序列表二
  - 嵌套一
  - 嵌套二
    - 嵌套三
- 无序列表三

1. 有序列表一
2. 有序列表二
   1. 嵌套有序一
   2. 嵌套有序二

- [x] 已完成任务
- [ ] 未完成任务

## 引用块

> 这是一段引用内容
>
> 多行引用第二行
>
> - 引用内的列表
> - 引用内的列表二

## 代码块 (高亮测试)

```js
function greet(name) {
  // 这是一条注释
  const message = `Hello, ${name}!`;
  return message;
}

greet("Typora");
```

```python
def fib(n):
    """斐波那契"""
    if n <= 1:
        return n
    return fib(n - 1) + fib(n - 2)

print([fib(i) for i in range(10)])
```

```html
<div class="box">
  <p>HTML 代码块</p>
  <span id="test">高亮</span>
</div>
```

无语言代码块:

```
plain text 代码块
没有语言标记
```

## 表格

| 列A | 列B | 列C |
|-----|-----|-----|
| 甲 | 乙 | 丙 |
| 1 | 2 | 3 |
| 长文本单元格 | 更多内容 | 对齐测试 |

## 数学公式

行内公式: $E = mc^2$ 和 $\alpha + \beta = \gamma$，还有分数 $\frac{1}{2}$。

块级公式:

$$
\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}
$$

## 图片 (相对路径)

![渐变测试图片](test-image.png)

## 链接 (本地文件)

点击这里应该能在另一栏打开: [测试目标文件](测试目标文件.md)

---

## 压力测试段落

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

这是压力测试段落，用于验证大文档滚动和渲染性能。包含**加粗**、*斜体*、`代码`、[链接](https://example.org) 等元素。除了文字还有列表：

- 压力测试条目一
- 压力测试条目二
- 压力测试条目三

> 压力测试引用块

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

这是压力测试段落，用于验证大文档滚动和渲染性能。包含**加粗**、*斜体*、`代码`、[链接](https://example.org) 等元素。除了文字还有列表：

- 压力测试条目一
- 压力测试条目二
- 压力测试条目三

> 压力测试引用块

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

这是压力测试段落，用于验证大文档滚动和渲染性能。包含**加粗**、*斜体*、`代码`、[链接](https://example.org) 等元素。除了文字还有列表：

- 压力测试条目一
- 压力测试条目二
- 压力测试条目三

> 压力测试引用块

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

这是压力测试段落，用于验证大文档滚动和渲染性能。包含**加粗**、*斜体*、`代码`、[链接](https://example.org) 等元素。除了文字还有列表：

- 压力测试条目一
- 压力测试条目二
- 压力测试条目三

> 压力测试引用块

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

这是压力测试段落，用于验证大文档滚动和渲染性能。包含**加粗**、*斜体*、`代码`、[链接](https://example.org) 等元素。除了文字还有列表：

- 压力测试条目一
- 压力测试条目二
- 压力测试条目三

> 压力测试引用块

