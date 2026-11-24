#!/usr/bin/env python
"""把一批字幕条图片 OCR 成文本。

用法：
    echo '[{"t":12.9,"path":"a.png"}]' | python scripts/ocr-subtitles.py
输出：
    [{"t":12.9,"text":"我出去买面","conf":1.0,"ms":3400}]

依赖（没装也能跑，只是全返回空，调用方会退回"只发画面"）：
    python -m pip install rapidocr-onnxruntime

为什么是 RapidOCR 不是 tesseract：tesseract 的中文模型是印刷体训练的，
B站 这种设计字体 + 半透明 + 动态背景它读不准（实测 6 帧只对 1~2 帧）。
RapidOCR 是 PaddleOCR 的 onnxruntime 轻量版，同几张图逐字正确、置信度 1.0。
本地跑、不联网、不花钱。

速度：CPU 上约 3~4 秒/张（含版面检测）。所以调用方要控制条数，
别把 5 分钟里每一帧都送来。
"""
import json
import os
import sys
import time


def shrink(path: str) -> str:
    """宽超过 600 就缩下来。返回新的临时路径（或原路径）。"""
    try:
        from PIL import Image
        img = Image.open(path)
        if img.width > 600:
            ratio = 600 / img.width
            img = img.resize((600, max(1, int(img.height * ratio))), Image.LANCZOS)
            small = path + ".small.png"
            img.save(small)
            return small
    except Exception:
        pass
    return path


def main() -> None:
    try:
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass

    try:
        items = json.load(sys.stdin)
    except Exception:
        print("[]")
        return
    if not isinstance(items, list) or not items:
        print("[]")
        return

    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as error:  # 依赖没装：如实返回，别假装识别过
        print(json.dumps(
            [{"t": it.get("t", 0), "text": "", "conf": 0, "error": f"no-ocr: {error}"} for it in items],
            ensure_ascii=False,
        ))
        return

    engine = RapidOCR()
    out = []
    for item in items:
        t = item.get("t", 0)
        path = item.get("path", "")
        start = time.time()
        small = None
        try:
            small = shrink(path)
            result, _elapsed = engine(small)
            texts = [seg[1] for seg in (result or [])]
            confs = [float(seg[2]) for seg in (result or [])]
            out.append({
                "t": t,
                "text": "".join(texts).strip(),
                "conf": round(max(confs), 2) if confs else 0.0,
                "ms": int((time.time() - start) * 1000),
            })
        except Exception as error:
            out.append({"t": t, "text": "", "conf": 0.0, "error": str(error), "ms": int((time.time() - start) * 1000)})
        finally:
            if small and small != path:
                try:
                    os.remove(small)
                except Exception:
                    pass

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
