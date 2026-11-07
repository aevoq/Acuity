"""
Webcam detection with YOLOE-26n: you choose the objects by name.

Usage:
  python yolo_camera.py           # webcam, press q to quit

Edit the CLASSES list to add or remove objects. Plain English names work.
Traffic lights also get the colour that is lit (red, amber or green).
"""
import cv2
import numpy as np
from ultralytics import YOLOE

CLASSES = [
    "person",
    "bicycle",
    "car",
    "bus",
    "motorcycle",
    "dog",
    "cat",
    "bird",
    "trash can",
    "street light",
    "traffic light",
    "bench",
    "bollard",
    "tree",
    "road",
    "sidewalk",
    "crosswalk",
    "curb",
    "pole",
    "stairs",
]
CONF = 0.25  # open-vocabulary scores run lower than normal YOLO, so start low

# Lit-lamp colours as OpenCV hue ranges (0-179), set from webcam captures of
# a green-light photo: through a webcam the lamp washes out to a pale
# blue-green (hue ~100-107), so green reaches 112. Hues 113-159 (blue sky,
# screen tint) never count.
LIGHT_HUES = {
    "red":   [(0, 12), (160, 179)],
    "amber": [(13, 34)],
    "green": [(35, 112)],
}
LIGHT_MIN_SAT = 20    # washed-out lamps have little colour (seen: 27-54)...
LIGHT_MIN_VAL = 90    # ...but are brighter than the dark housing
LIGHT_MIN_SHARE = 0.01  # at least 1% of the centre must be lit, else "unknown"


def traffic_light_colour(frame, box):
    """Return 'red', 'amber', 'green' or 'unknown' for one traffic-light box."""
    x1, y1, x2, y2 = (int(v) for v in box)
    crop = frame[max(y1, 0):y2, max(x1, 0):x2]
    w = crop.shape[1]
    crop = crop[:, w // 4: w - w // 4]  # centre half: lamps, not background
    if crop.size == 0:
        return "unknown"
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    lit = (s >= LIGHT_MIN_SAT) & (v >= LIGHT_MIN_VAL)
    counts = {
        colour: int(sum(np.count_nonzero(lit & (h >= lo) & (h <= hi))
                        for lo, hi in ranges))
        for colour, ranges in LIGHT_HUES.items()
    }
    colour, n = max(counts.items(), key=lambda kv: kv[1])
    return colour if n >= max(10, LIGHT_MIN_SHARE * h.size) else "unknown"


LABEL_BGR = {"red": (0, 0, 255), "amber": (0, 191, 255),
             "green": (0, 200, 0), "unknown": (160, 160, 160)}

model = YOLOE("yoloe-26n-seg.pt")  # nano version, downloads the first time
model.set_classes(CLASSES)          # first run also downloads a text encoder

cap = cv2.VideoCapture(0)
if not cap.isOpened():
    raise SystemExit("Could not open the webcam. Check Windows camera privacy settings.")

print("Looking for:", ", ".join(CLASSES))
while True:
    ok, frame = cap.read()
    if not ok:
        break
    r = model.predict(frame, conf=CONF, verbose=False)[0]

    # Name each detection; traffic lights also get their colour,
    # e.g. "traffic light (red)"
    annotated = r.plot()
    names = []
    for cls, box in zip(r.boxes.cls.tolist(), r.boxes.xyxy.tolist()):
        name = CLASSES[int(cls)]
        if name == "traffic light":
            colour = traffic_light_colour(frame, box)
            name = f"traffic light ({colour})"
            x1, _, _, y2 = (int(v) for v in box)
            cv2.putText(annotated, colour.upper(), (x1, y2 + 22),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, LABEL_BGR[colour], 2)
        names.append(name)

    # Print what was seen this frame, e.g. "person x2, car, traffic light (red)"
    seen = ", ".join(f"{n} x{names.count(n)}" if names.count(n) > 1 else n
                     for n in dict.fromkeys(names))
    print(f"({r.speed['inference']:.0f} ms) {seen or 'nothing'}".ljust(100), end="\r")

    cv2.imshow("YOLOE-26n (press q to quit)", annotated)
    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

cap.release()
cv2.destroyAllWindows()