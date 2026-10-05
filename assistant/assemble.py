"""Merge the labelled batches into the eval dataset: v1-scope requests that stuck, durations in
minutes, day-number dates as ISO, and a deterministic ~50/50 build/heldout split (the held-out
half is never tuned on). The dataset is the user's real plan, so it lives OUTSIDE this repo
(client data never enters it): $TS_ASSISTANT_STATE, default ~/.agents/state/timeline-studio-assistant."""
import glob, hashlib, json, os, sys

items = []
for f in sorted(glob.glob(sys.argv[1] if len(sys.argv) > 1 else "/tmp/ts_labels_*.json")):
    items += [x for x in json.load(open(f)) if "utterance" in x]

out = []
for x in items:
    if not x.get("in_v1") or x.get("stuck") is False or not x.get("gold"):
        continue
    for c in x["gold"]:
        t = c.get("task") if c.get("type") == "addTask" else c
        if isinstance(t, dict) and isinstance(t.get("dur"), (int, float)) and t["dur"] < 15:
            t["dur"] = round(t["dur"] * 1440)          # pre-v7 plans stored days
        if isinstance(c.get("due"), (int, float)):      # pre-v6 day numbers from 2026-09-19
            from datetime import date, timedelta
            c["due"] = (date(2026, 9, 19) + timedelta(days=c["due"])).isoformat() + "T17:00:00.000Z"
    h = hashlib.sha1(x["utterance"].encode()).hexdigest()
    out.append({"id": h[:8], "at": x["at"], "utterance": x["utterance"], "kind": x["kind"],
                "gold": x["gold"], "split": "heldout" if int(h, 16) % 2 else "build",
                **({"note": x["note"]} if x.get("note") else {})})
out.sort(key=lambda x: x["at"])
state = os.environ.get("TS_ASSISTANT_STATE", os.path.expanduser("~/.agents/state/timeline-studio-assistant"))
os.makedirs(state, exist_ok=True)
path = os.path.join(state, "dataset.json")
json.dump(out, open(path, "w"), indent=1)
from collections import Counter
print(len(out), "items;", Counter(x["split"] for x in out), Counter(x["kind"] for x in out))
