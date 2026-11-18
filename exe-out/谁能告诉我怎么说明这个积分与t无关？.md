---
title: "谁能告诉我怎么说明这个积分与t无关？"
source: https://www.zhihu.com/question/2105779343171572976
question_id: 2105779343171572976
answer_count: 1
fetched_answers: 1
fetched_at: "2026-11-18 23:02"
---

# 谁能告诉我怎么说明这个积分与t无关？

> 原问题: <https://www.zhihu.com/question/2105779343171572976>
> 1 个回答 · 3 人关注 · 338 次浏览
> 已抓取 1 条回答 · 2026-11-18 23:02

## 问题描述

![](assets/b51f5d4114b2.jpg)

---

## 回答目录

1. [梦影](#回答-1) · 6 赞同

---

## 回答 1

**梦影** — 是非审之于己，毁誉听之于人，得失安之于数，陟岳麓峰头，朗月清风，太极悠然可会；君亲恩何以酬，民物命何以立，圣贤道何以传，登赫曦台上，衡云湘水，斯文定有攸归。‌

> 6 赞同 · 0 条评论 · 发布于 2026-11-17 12:32
> 回答链接: <https://www.zhihu.com/question/2105779343171572976/answer/2106001832174798267>
> 作者主页: <https://www.zhihu.com/people/34-64-64-42>

蟹幺！

设 $n\in\mathbb Z_{\ge 0}$，$t\in\mathbb R$，记

$$
J_n(t)=\int_{-1}^{1} \frac{(1-x^2)^n} {(1-2xt+t^2)^{n+\frac12}}\,dx.
$$

题图只给出了积分定义，下面研究 $J_n(t)$ 的精确表达式及其关于 $t$ 的性质。

#### 解法一：初等换元法（奇函数积分）

当 $|t|<1$ 时，令

$$
u=\frac{x-t}{\sqrt{1-2xt+t^2}}.
$$

记

$$
r=\sqrt{1-2xt+t^2}.
$$

则

$$
u=\frac{x-t}{r}, \qquad x=t+ur.
$$

由

$$
r^2-(x-t)^2=1-x^2,
$$

得

$$
1-u^2=\frac{1-x^2}{r^2}. \tag{1}
$$

对 $x$ 求导，

$$
\begin{aligned} \frac{du}{dx} &=\frac1r-\frac{(x-t)(x-t)'}{r^2}\frac{dr}{dx} -\frac{x-t}{r^2} \left(\frac{dr}{dx}-\frac{x-t}{r}\right) \end{aligned}
$$

直接由 $u=(x-t)/r$、$r'=-t/r$ 化简，得

$$
\frac{du}{dx} =\frac{r^2+t(x-t)}{r^3} =\frac{1-tx}{r^3}. \tag{2}
$$

由于 $|t|<1$，在 $[-1,1]$ 上恒有

$$
1-tx>0.
$$

故 $u$ 关于 $x$ 严格递增，且

$$
x=-1\Longrightarrow u=-1,
$$

$$
x=1\Longrightarrow u=1.
$$

由（1）（2），

$$
\begin{aligned} \frac{(1-x^2)^n}{r^{2n+1}}\,dx &=(1-u^2)^n r\,dx\\ &=(1-u^2)^n\frac{r^4}{1-tx}\frac{du}{r^2}\\ &=(1-u^2)^n\frac{r^2}{1-tx}\,du. \end{aligned}
$$

另一方面，

$$
r^2=1-t^2-2tur,
$$

故

$$
(r+tu)^2=1-t^2+t^2u^2.
$$

又

$$
r+tu=\frac{1-tx}{r}>0,
$$

从而

$$
r=\sqrt{1-t^2+t^2u^2}-tu.
$$

于是

$$
\begin{aligned} \frac{r^2}{1-tx} &=\frac{r}{r+tu}\\ &=1-\frac{tu}{\sqrt{1-t^2+t^2u^2}}. \end{aligned}
$$

原积分化为

$$
\begin{aligned} J_n(t) &=\int_{-1}^{1}(1-u^2)^n \left( 1-\frac{tu}{\sqrt{1-t^2+t^2u^2}} \right)du\\ &=\int_{-1}^{1}(1-u^2)^n\,du\\ &\quad-t\int_{-1}^{1} \frac{u(1-u^2)^n} {\sqrt{1-t^2+t^2u^2}}\,du. \end{aligned}
$$

注意到

$$
\frac{u(1-u^2)^n} {\sqrt{1-t^2+t^2u^2}}
$$

是关于 $u$ 的奇函数，故

$$
\int_{-1}^{1} \frac{u(1-u^2)^n} {\sqrt{1-t^2+t^2u^2}}\,du=0.
$$

于是

$$
\boxed{ J_n(t)=\int_{-1}^{1}(1-u^2)^n\,du \qquad(|t|<1). } \tag{3}
$$

记

$$
A_n=\int_{-1}^{1}(1-u^2)^n\,du.
$$

显然

$$
A_0=2.
$$

当 $n\ge1$ 时，分部积分得

$$
\begin{aligned} A_n &=\left[u(1-u^2)^n\right]_{-1}^{1} +2n\int_{-1}^{1}u^2(1-u^2)^{n-1}du\\ &=2n\int_{-1}^{1}u^2(1-u^2)^{n-1}du. \end{aligned}
$$

又

$$
\begin{aligned} A_{n-1} &=\int_{-1}^{1}(1-u^2)^{n-1}du\\ &=A_n+\int_{-1}^{1}u^2(1-u^2)^{n-1}du\\ &=A_n+\frac{A_n}{2n}. \end{aligned}
$$

即

$$
A_n=\frac{2n}{2n+1}A_{n-1}.
$$

递推得到

$$
\begin{aligned} A_n &=2\prod_{k=1}^{n}\frac{2k}{2k+1}\\ &=2\cdot \frac{2^nn!}{(2n+1)!!}\\ &=\frac{2^{2n+1}(n!)^2}{(2n+1)!}. \end{aligned} \tag{4}
$$

#### 边界情形 $|t|=1$

由 $x\mapsto -x$，有

$$
J_n(-t)=J_n(t).
$$

只需计算 $t=1$。

$$
\begin{aligned} J_n(1) &=\int_{-1}^{1} \frac{(1-x^2)^n}{(2-2x)^{n+\frac12}}dx\\ &=\frac1{2^{n+\frac12}} \int_{-1}^{1} \frac{(1+x)^n}{\sqrt{1-x}}dx. \end{aligned}
$$

令

$$
u=\sqrt{\frac{1-x}{2}}, \qquad x=1-2u^2, \qquad dx=-4u\,du.
$$

则

$$
\begin{aligned} J_n(1) &=2\int_0^1(1-u^2)^n\,du\\ &=\int_{-1}^{1}(1-u^2)^n\,du\\ &=A_n. \end{aligned}
$$

故（3）在 $|t|=1$ 时仍成立，其中端点处的积分按广义积分理解。

#### 情形 $|t|>1$

由

$$
1-2xt+t^2 =t^2\left(1-\frac{2x}{t}+\frac1{t^2}\right),
$$

得

$$
\begin{aligned} J_n(t) &=\frac1{|t|^{2n+1}} \int_{-1}^{1} \frac{(1-x^2)^n} {\left(1-\frac{2x}{t}+\frac1{t^2}\right)^{n+\frac12}}dx\\ &=\frac1{|t|^{2n+1}}J_n\left(\frac1t\right). \end{aligned}
$$

此时 $\left|\frac1t\right|<1$，故

$$
\boxed{ J_n(t)=\frac{A_n}{|t|^{2n+1}} \qquad(|t|>1). } \tag{5}
$$

---
