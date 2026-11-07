"""
Webcam detection with YOLOE-26n: you choose the objects by name.

Usage:
  python yoloe_camera.py          # webcam, press q to quit

Edit the CLASSES list to add or remove objects. Plain English names work.
"""
import cv2
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

    # Print what was seen this frame, e.g. "person x2, car, trash can"
    names = [CLASSES[int(c)] for c in r.boxes.cls.tolist()]
    seen = ", ".join(f"{n} x{names.count(n)}" if names.count(n) > 1 else n
                     for n in dict.fromkeys(names))
    print(f"({r.speed['inference']:.0f} ms) {seen or 'nothing'}", end="\r")

    cv2.imshow("YOLOE-26n (press q to quit)", r.plot())
    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

cap.release()
cv2.destroyAllWindows()