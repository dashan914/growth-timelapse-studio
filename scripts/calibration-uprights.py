"""Trusted local OpenCV line suggestions. Photo bytes are data, never commands.

These are visual edges, not semantic detections of physical upright rods.
The UI must confirm them before using them for camera calibration.
"""
import json
import math
import sys
from pathlib import Path

MAX_BYTES = 24 * 1024 * 1024
MAX_PIXELS = 24_000_000
MAX_EDGE = 12_000
METHOD = 'OpenCV LSD + collinear grouping'


def suggest(image, cv, np):
    h, w = image.shape[:2]
    scale = min(1.0, 1280.0 / max(w, h))
    if scale < 1:
        image = cv.resize(image, (round(w * scale), round(h * scale)), interpolation=cv.INTER_AREA)
    gray = cv.cvtColor(image, cv.COLOR_BGR2GRAY)
    height, width = gray.shape
    detected = cv.createLineSegmentDetector(cv.LSD_REFINE_STD).detect(gray)[0]
    candidates = []
    if detected is not None:
        for raw in detected[:, 0]:
            a, b = np.array(raw[:2], float), np.array(raw[2:], float)
            if a[1] > b[1]:
                a, b = b, a
            delta = b - a
            span = float(np.linalg.norm(delta))
            if span < height * .09 or delta[1] <= 0 or abs(delta[0]) > delta[1] * .55 or a[1] > height * .5:
                continue
            candidates.append({'points': [a, b], 'span': span})
    # Long segments first. Resource bound for heavily textured photographs.
    candidates.sort(key=lambda item: item['span'], reverse=True)
    candidates = candidates[:160]
    groups = []
    tolerance = max(2.5, width * .004)
    for candidate in candidates:
        a, b = candidate['points']
        delta = b - a
        direction = delta / candidate['span']
        selected = None
        for group in groups:
            ga, gb = group['a'], group['b']
            gd = (gb - ga) / np.linalg.norm(gb - ga)
            sine = abs(float(direction[0] * gd[1] - direction[1] * gd[0]))
            # Coplanar parallel edges of the same thin rod can differ by a few
            # pixels. Gaps may come from occlusion, but are never extrapolated.
            midpoint = (a + b) / 2
            distance = abs(float((midpoint[0] - ga[0]) * gd[1] - (midpoint[1] - ga[1]) * gd[0]))
            gap = max(0, min(a[1], ga[1]) - min(b[1], gb[1]), max(a[1], ga[1]) - min(b[1], gb[1]))
            if sine < math.sin(math.radians(2.5)) and distance < tolerance and gap < height * .19:
                selected = group
                break
        if selected is None:
            groups.append({'a': a, 'b': b, 'points': [a, b], 'support': candidate['span']})
        else:
            selected['points'].extend([a, b])
            selected['support'] += candidate['span']
            pts = np.array(selected['points'])
            center = pts.mean(axis=0)
            _, _, vectors = np.linalg.svd(pts - center, full_matrices=False)
            axis = vectors[0]
            if axis[1] < 0:
                axis = -axis
            distances = (pts - center) @ axis
            selected['a'] = center + axis * distances.min()
            selected['b'] = center + axis * distances.max()
    groups = sorted(groups, key=lambda group: np.linalg.norm(group['b'] - group['a']), reverse=True)[:40]
    best_pair = None
    best_score = -1
    for i, first in enumerate(groups):
        for second in groups[i + 1:]:
            a, b = first['a'], first['b']
            c, d = second['a'], second['b']
            len1, len2 = np.linalg.norm(b - a), np.linalg.norm(d - c)
            sep = abs((a[0] + b[0] - c[0] - d[0]) / 2)
            if min(len1, len2) < height * .18 or sep < width * .25:
                continue
            l1 = np.cross(np.array([*a, 1]), np.array([*b, 1]))
            l2 = np.cross(np.array([*c, 1]), np.array([*d, 1]))
            vp = np.cross(l1, l2)
            if abs(vp[2]) < 1e-8:
                plausible = True  # Uprights can be almost parallel in image.
            else:
                vx, vy = vp[0] / vp[2], vp[1] / vp[2]
                low_x = min((a[0] + b[0]) / 2, (c[0] + d[0]) / 2) - width * .25
                high_x = max((a[0] + b[0]) / 2, (c[0] + d[0]) / 2) + width * .25
                plausible = low_x < vx < high_x and (vy < -height * .2 or vy > height * 2)
            if not plausible:
                continue
            # Spread and long unextrapolated coverage, rather than counting
            # every duplicate textured edge as independent evidence.
            score = min(len1, height) + min(len2, height) + .35 * sep
            if score > best_score:
                best_pair, best_score = [first, second], score
    chosen = sorted(best_pair or [], key=lambda group: (group['a'][0] + group['b'][0]) / 2)
    lines = []
    for group in chosen:
        a, b = group['a'], group['b']
        lines.append({'a': {'x': float(np.clip(a[0] / width, 0, 1)), 'y': float(np.clip(a[1] / height, 0, 1))},
                      'b': {'x': float(np.clip(b[0] / width, 0, 1)), 'y': float(np.clip(b[1] / height, 0, 1))},
                      'weight': 100})
    warnings = ['检测到的是照片中的线段候选，请确认它们确实是实景中竖直的立柱或导杆，再用于对齐。']
    if len(lines) < 2:
        warnings.append('没有找到足够清晰且相隔较远的两条竖线，请手动标记。')
    return {'lines': lines, 'confidence': 'suggested' if len(lines) == 2 else 'low',
            'warnings': warnings, 'method': METHOD, 'version': cv.__version__,
            'imageSize': {'width': w, 'height': h}}


def main():
    import cv2 as cv
    import numpy as np
    cv.setNumThreads(1)
    if len(sys.argv) != 2:
        raise ValueError('A single server-created image file is required')
    source = Path(sys.argv[1])
    if not source.is_file() or source.stat().st_size > MAX_BYTES:
        raise ValueError('Image size is not supported')
    data = source.read_bytes()
    image = cv.imdecode(np.frombuffer(data, dtype=np.uint8), cv.IMREAD_COLOR)
    if image is None:
        raise ValueError('Image could not be decoded')
    h, w = image.shape[:2]
    if min(w, h) < 16 or max(w, h) > MAX_EDGE or w * h > MAX_PIXELS:
        raise ValueError('Image dimensions are not supported')
    print(json.dumps(suggest(image, cv, np), ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Diagnostics stay generic. Do not reflect filesystem paths or Python
        # tracebacks into the browser.
        print(json.dumps({'error': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
