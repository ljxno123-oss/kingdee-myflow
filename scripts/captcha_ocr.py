#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
金蝶验证码本地 OCR 识别脚本（含图像预处理，提升带干扰线验证码的识别准确率）。
供 kd_myflow.js 调用：截图验证码后，直接本地识别，无需外部 Agent 介入。

用法：
    python captcha_ocr.py <验证码图片路径> [输出文件]

行为：
  - 读取图片 → 预处理（灰度 + 中值滤波去噪 + Otsu 二值化 + 放大）→ ddddocr 识别。
  - 清洗结果：只保留字母数字；若含中文字符或长度异常，尝试二次识别（反色/放大兜底）。
  - 若给了「输出文件」，把结果写入该文件；否则打印到 stdout。
  - 退出码：0=成功，非 0=失败。
"""
import sys
import re
import io


def preprocess(cv2, np, img):
    """返回一组候选预处理图像（bytes），按优先级排序。"""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    cands = []
    # 候选1：中值滤波去噪 + Otsu 二值化 + 放大（对金蝶验证码效果最好）
    blur = cv2.medianBlur(g, 3)
    _, bin_img = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    big = cv2.resize(bin_img, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    cands.append(('median_otsu_x3', big))
    # 候选2：Otsu 二值 + 放大
    _, bin2 = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    big2 = cv2.resize(bin2, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    cands.append(('otsu_x3', big2))
    # 候选3：原始灰度放大
    big3 = cv2.resize(g, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    cands.append(('gray_x3', big3))

    out = []
    for name, im in cands:
        ok, buf = cv2.imencode('.png', im)
        if ok:
            out.append((name, buf.tobytes()))
    return out


def clean(raw):
    """清洗：只保留字母数字，去掉中文误识。"""
    s = re.sub(r'[^0-9a-zA-Z]', '', raw or '')
    return s


def main():
    if len(sys.argv) < 2:
        print('用法: python captcha_ocr.py <图片路径> [输出文件]', file=sys.stderr)
        sys.exit(2)

    img_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        import ddddocr
        import cv2
        import numpy as np
    except ImportError as e:
        print('缺少依赖库：请先执行 python -m pip install ddddocr opencv-python numpy', file=sys.stderr)
        sys.exit(3)

    try:
        img = cv2.imread(img_path)
        if img is None:
            print('读取图片失败（可能损坏或路径错误）', file=sys.stderr)
            sys.exit(4)
    except Exception as e:
        print('读取图片失败: %s' % e, file=sys.stderr)
        sys.exit(4)

    try:
        # beta 模型对带干扰线验证码识别更准（实测默认模型会把 r 误识成 /，beta 能正确识别）
        ocr = ddddocr.DdddOcr(show_ad=False, beta=True)
        ocr_default = ddddocr.DdddOcr(show_ad=False)
    except Exception as e:
        print('初始化 ddddocr 失败: %s' % e, file=sys.stderr)
        sys.exit(5)

    ans = None
    # 逐候选预处理识别，取第一个「纯 4 位字母数字」的结果
    # 对每个候选分别用 beta 和默认模型识别，beta 结果优先（更准）
    for name, buf in preprocess(cv2, np, img):
        for tag, o in (('beta', ocr), ('default', ocr_default)):
            try:
                raw = o.classification(buf)
            except Exception:
                continue
            c = clean(raw)
            if len(c) == 4:
                ans = c
                sys.stderr.write('[%s/%s] -> %r\n' % (name, tag, c))
                break
            sys.stderr.write('[%s/%s] -> %r (clean=%r)\n' % (name, tag, raw, c))
        if ans:
            break

    if not ans:
        print('OCR 未能识别出 4 位字符', file=sys.stderr)
        sys.exit(6)

    if out_path:
        try:
            with open(out_path, 'w', encoding='utf-8') as f:
                f.write(ans)
        except OSError as e:
            print('写入结果失败: %s' % e, file=sys.stderr)
            sys.exit(7)
        print('OCR_OK %s -> %s' % (img_path, ans))
    else:
        print(ans)

    sys.exit(0)


if __name__ == '__main__':
    main()
