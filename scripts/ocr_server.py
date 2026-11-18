#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
金蝶验证码 OCR 常驻服务（stdin/stdout 行协议）。
目的：消除每次调用 `python captcha_ocr.py` 的 12s 冷启动（ddddocr/opencv/onnx 首次加载）。
    服务启动后模型常驻内存，后续每次识别仅 ~0.5s。

协议（每行一个 JSON）：
  请求: {"id": <int>, "img": "<图片绝对路径>"}
  响应: {"id": <int>, "ok": true, "ans": "6337", "ms": 512}
        或  {"id": <int>, "ok": false, "err": "..."}
  __ready__ 握手（启动完成时输出一行）: {"ready": true}

复用 captcha_ocr.py 的预处理逻辑（灰度 + 中值滤波 + Otsu 二值化 + 放大 + beta/default 双模型）。
"""
import sys
import json
import re

try:
    import ddddocr
    import cv2
    import numpy as np
except ImportError as e:
    print(json.dumps({"ready": False, "err": "缺少依赖: %s" % e}), flush=True)
    sys.exit(3)


def clean(raw):
    return re.sub(r'[^0-9a-zA-Z]', '', raw or '')


def preprocess(img):
    """返回候选预处理图像 bytes 列表（复用 captcha_ocr.py 逻辑）。"""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    cands = []
    blur = cv2.medianBlur(g, 3)
    _, bin_img = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    big = cv2.resize(bin_img, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    cands.append(big)
    _, bin2 = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    big2 = cv2.resize(bin2, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    cands.append(big2)
    big3 = cv2.resize(g, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    cands.append(big3)
    out = []
    for im in cands:
        ok, buf = cv2.imencode('.png', im)
        if ok:
            out.append(buf.tobytes())
    return out


def main():
    # 初始化模型（只做一次）
    ocr_beta = ddddocr.DdddOcr(show_ad=False, beta=True)
    ocr_default = ddddocr.DdddOcr(show_ad=False)
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        img_path = req.get("img")
        t0 = __import__("time").time()
        try:
            img = cv2.imread(img_path)
            if img is None:
                print(json.dumps({"id": rid, "ok": False, "err": "read fail"}), flush=True)
                continue
            ans = None
            for buf in preprocess(img):
                for tag, o in (("beta", ocr_beta), ("default", ocr_default)):
                    try:
                        raw = o.classification(buf)
                    except Exception:
                        continue
                    c = clean(raw)
                    if len(c) == 4:
                        ans = c
                        break
                if ans:
                    break
            if ans:
                print(json.dumps({"id": rid, "ok": True, "ans": ans, "ms": int((__import__("time").time() - t0) * 1000)}), flush=True)
            else:
                print(json.dumps({"id": rid, "ok": False, "err": "no 4-char"}), flush=True)
        except Exception as e:
            print(json.dumps({"id": rid, "ok": False, "err": str(e)}), flush=True)


if __name__ == "__main__":
    main()
