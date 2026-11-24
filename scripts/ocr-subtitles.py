#!/usr/bin/env python
"""把一批字幕条图片 OCR 成文本。

用法：
    echo '[{"t":12.9,"path":"a.png"}]' | python scripts/ocr-subtitles.py
输出：
    [{"t":12.9,"text":"我出去买面","conf":1.0,"ms":31}]

依赖（没装也能跑，只是全返回空，调用方会退回"只发画面"）：
    python -m pip install rapidocr-onnxruntime

为什么是 RapidOCR 不是 tesseract：tesseract 的中文模型是印刷体训练的，
B站 这种设计字体 + 半透明 + 动态背景它读不准（实测 6 帧只对 1~2 帧）。
RapidOCR 是 PaddleOCR 的 onnxruntime 轻量版，同几张图逐字正确、置信度 1.0。

关键：**关掉版面检测和方向分类**（use_det=False / use_cls=False）。
字幕条是"已经裁好的一行字"，不需要检测文字框在哪。
实测：默认 3.3~5.0 秒/张 → 关掉后 0.03 秒/张，快 100 倍，准确率不变。
（所以也不用上 GPU——瓶颈从来不是推理，是那次没必要的检测。）

注意 use_det=False 时返回格式变了：[(text, score)]，不是默认的 [(box, text, score)]。
"""
import json
import os
import sys
import time


def shrink(path: str) -> str:
    """宽超过 600 就缩下来。返回临时路径（或原路径）。"""
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


def parse(result):
    """兼容两种返回格式，返回 (文本, 最高置信度)。"""
    if not result:
        return "", 0.0
    first = result[0]
    if isinstance(first, (list, tuple)) and len(first) >= 2 and isinstance(first[0], str):
        # use_det=False: [(text, score)]
        return "".join(str(x[0]) for x in result), max(float(x[1]) for x in result)
    if isinstance(first, (list, tuple)) and len(first) >= 3:
        # 默认: [(box, text, score)]
        return "".join(str(x[1]) for x in result), max(float(x[2]) for x in result)
    return "", 0.0


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

    # 关掉检测和分类：字幕条只有一行字，那两步是纯浪费（100 倍的时间差）
    engine = RapidOCR(use_det=False, use_cls=False)

    out = []
    for item in items:
        t = item.get("t", 0)
        path = item.get("path", "")
        start = time.time()
        small = None
        try:
            small = shrink(path)
            result, _elapsed = engine(small)
            text, conf = parse(result)
            out.append({
                "t": t,
                "text": text.strip(),
                "conf": round(conf, 2),
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
