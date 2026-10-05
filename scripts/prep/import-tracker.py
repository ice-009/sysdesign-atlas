#!/usr/bin/env python3
"""Turns the HLD and LLD tabs of the switch-prep tracker workbook into
lib/prep-plan.json — the plan the iPad edition's Plan page and the website
dashboard schedule from.

The reading lives in Atlas itself: every item points at the Atlas topics that
teach it (READS below), and the sheet's own links are dropped — except
LeetCode, which stays as the place to practise a problem.

    python3 scripts/prep/import-tracker.py ~/Downloads/switch_prep_tracker.xlsx

What comes across, per row: week, sheet topic, item, difficulty, type, the
pre-filled note, the link, and any status already ticked in the sheet (as a
seed: a device that has never touched the item starts from it). The HLD and
LLD milestones (the two HLD mocks and the final dry run) come from the
Milestones tab. Each item is also matched to the Atlas topics that teach it
(READS below), so the plan can open the reading offline.

Needs openpyxl (pip install openpyxl). Re-run it whenever the sheet changes;
the output is deterministic.
"""

import datetime as dt
import json
import pathlib
import sys

import openpyxl

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "lib" / "prep-plan.json"

START = dt.date(2026, 9, 20)  # week 1 begins on this Sunday
WEEKS = 9

# Minutes each kind of item tends to take; the scheduler balances days with these.
MINUTES = {
    ("Learn", ""): 40,
    ("Design", "Medium"): 75,
    ("Design", "Hard"): 100,
    ("Practice", "Easy"): 45,
    ("Practice", "Medium"): 60,
    ("Practice", "Hard"): 90,
}

# Atlas topics for each item: "section/slug" or "section/slug#heading-id".
READS = {
    "hld": {
        1: ["appendix/framework", "appendix/what-interviewers-score"],
        2: ["fundamentals/scalability-basics"],
        3: ["building-blocks/load-balancing"],
        4: ["building-blocks/caching"],
        5: ["building-blocks/cdn"],
        6: ["building-blocks/proxies"],
        7: ["building-blocks/sql-vs-nosql"],
        8: ["building-blocks/replication"],
        9: ["building-blocks/indexing#dense-vs-sparse"],
        10: ["building-blocks/sharding"],
        11: ["building-blocks/consistent-hashing"],
        12: ["fundamentals/cap-pacelc"],
        13: ["data/transactions-isolation#acid-vs-base", "fundamentals/consistency-models"],
        14: ["building-blocks/message-queues", "data/stream-processing"],
        15: ["building-blocks/pub-sub"],
        16: ["building-blocks/monoliths-microservices"],
        17: ["building-blocks/api-gateway"],
        18: ["building-blocks/api-gateway#rest-vs-grpc-vs-graphql"],
        19: ["building-blocks/realtime"],
        20: ["distributed/distributed-transactions"],
        21: ["fundamentals/failure-modes", "distributed/backpressure"],
        22: ["fundamentals/availability-slas"],
        23: ["case-studies/url-shortener"],
        24: ["builds/pastebin"],
        25: ["case-studies/rate-limiter", "building-blocks/rate-limiting"],
        26: ["case-studies/key-value-store"],
        27: ["case-studies/web-crawler"],
        28: ["case-studies/news-feed", "builds/twitter"],
        29: ["case-studies/chat-system", "builds/whatsapp"],
        30: ["case-studies/notification-system"],
        31: ["case-studies/video-streaming", "builds/netflix"],
        32: ["builds/instagram"],
        33: ["case-studies/ride-sharing", "builds/uber"],
        34: ["building-blocks/geospatial", "case-studies/ride-sharing"],
        35: ["case-studies/distributed-cache"],
        36: ["case-studies/distributed-log", "building-blocks/message-queues"],
        37: ["case-studies/file-sync", "building-blocks/object-storage"],
        38: ["case-studies/autocomplete"],
        39: ["case-studies/payment-system", "builds/stripe"],
        40: ["case-studies/ticket-booking"],
        41: ["case-studies/job-scheduler"],
        42: ["case-studies/metrics-monitoring", "lld/alerting-system"],
    },
    "lld": {
        1: ["lld/solid"],
        2: ["lld/uml-class-diagrams"],
        3: ["lld/design-patterns#factory-one-place-that-knows-how-to-build-things", "lld/design-patterns#builder-construction-with-many-options"],
        4: ["lld/design-patterns#decorator-wrap-to-add-behaviour", "lld/design-patterns#facade-one-simple-door-into-a-complicated-subsystem"],
        5: ["lld/design-patterns#strategy-the-one-youll-use-most", "lld/design-patterns#observer-announce-it-dont-call-everyone"],
        6: ["lld/code-smells"],
        7: ["lld/lld-interview-method", "lld/three-day-plan"],
        8: ["lld/parking-lot"],
        9: ["lld/vending-machine"],
        10: ["lld/elevator-system"],
        11: ["lld/library-management"],
        12: ["lld/chess"],
        13: ["lld/splitwise"],
        14: ["hld-bridge/seat-booking", "lld/concurrency-in-lld"],
        15: ["lld/atm"],
        16: ["lld/lru-cache", "lld/concurrency-in-lld"],
        17: ["lld/logging-framework"],
        18: ["lld/snake-and-ladder"],
        19: ["lld/alerting-system"],
    },
    "mile": {
        5: ["case-studies/url-shortener", "appendix/annotated-mock"],
        7: ["case-studies/chat-system", "appendix/framework"],
        9: ["hld-bridge/final-checklist", "appendix/question-bank"],
    },
}

# Milestones that belong to this plan (the rest are DSA / ML checkpoints).
MILESTONES = {5: 60, 7: 60, 9: 90}


def iso(d):
    return d.isoformat()


def week_range(n):
    a = START + dt.timedelta(days=7 * (n - 1))
    return a, a + dt.timedelta(days=6)


def as_date(v):
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    return ""


def practice_link(link):
    """Only LeetCode leaves the app; every other link's reading is in Atlas."""
    link = (link or "").strip()
    return link if link.startswith("https://leetcode.com/") else ""


def reads_for(track, num):
    out = []
    for ref in READS.get(track, {}).get(num, []):
        path, _, anchor = ref.partition("#")
        sec, slug = path.split("/")
        r = {"sec": sec, "slug": slug}
        if anchor:
            r["anchor"] = anchor
        out.append(r)
    return out


def seed_of(status, done, revisit, minutes, track, num):
    s = (status or "").strip().lower()
    seed = {}
    if s in ("done", "partial", "stuck"):
        seed["s"] = s
        if done:
            seed["at"] = as_date(done) or str(done)
    if (revisit or "").strip().upper() == "Y":
        seed["rev"] = True
    if isinstance(minutes, (int, float)) and minutes > 0:
        seed["min"] = int(minutes)
    return seed or None


def rows(ws):
    for r in ws.iter_rows(min_row=2, values_only=True):
        if r[4] is None:
            continue
        yield r


def main(src):
    wb = openpyxl.load_workbook(src, data_only=True)
    items = []
    for track, tab in (("hld", "HLD"), ("lld", "LLD")):
        for wk, _dates, topic, num, item, diff, status, done, rev, tm, notes, typ, link in rows(wb[tab]):
            num = int(num)
            title = str(item).strip()
            if title.startswith("Learn:"):
                title = title[len("Learn:"):].strip()
            typ = (typ or "").strip()
            diff = (diff or "").strip()
            minutes = MINUTES.get((typ, "" if typ == "Learn" else diff), 60)
            hint = (notes or "").strip()
            if hint == "No LeetCode equivalent":
                hint = ""
            it = {
                "id": f"{track}-{num}",
                "track": track,
                "num": num,
                "week": int(wk),
                "topic": (topic or "").strip(),
                "title": title,
                "type": typ,
                "difficulty": diff,
                "minutes": minutes,
                "hint": hint,
                "link": practice_link(link),
                "read": reads_for(track, num),
            }
            seed = seed_of(status, done, rev, tm, track, num)
            if seed:
                it["seed"] = seed
            items.append(it)

    for wk, _dates, topic, num, item, diff, status, done, rev, tm, notes, typ, link in rows(wb["Milestones"]):
        num = int(num)
        if num not in MILESTONES:
            continue
        it = {
            "id": f"mile-{num}",
            "track": "mile",
            "num": num,
            "week": int(wk),
            "topic": (topic or "").strip(),
            "title": str(item).strip().replace(" - ", " — "),
            "type": "Milestone",
            "difficulty": "",
            "minutes": MILESTONES[num],
            "hint": (notes or "").strip(),
            "link": practice_link(link),
            "read": reads_for("mile", num),
        }
        seed = seed_of(status, done, rev, tm, "mile", num)
        if seed:
            it["seed"] = seed
        items.append(it)

    missing = [f"{i['id']}" for i in items if not i["read"]]
    if missing:
        sys.exit(f"no Atlas reading mapped for: {', '.join(missing)}")

    weeks = []
    for n in range(1, WEEKS + 1):
        a, b = week_range(n)
        weeks.append({"n": n, "from": iso(a), "to": iso(b)})

    plan = {
        "source": pathlib.Path(src).name,
        "start": iso(START),
        "end": weeks[-1]["to"],
        "weeks": weeks,
        "items": items,
    }
    OUT.write_text(json.dumps(plan, indent=1, ensure_ascii=False) + "\n")
    n = {t: sum(1 for i in items if i["track"] == t) for t in ("hld", "lld", "mile")}
    seeded = sum(1 for i in items if "seed" in i)
    print(f"{OUT.relative_to(ROOT)}: {n['hld']} HLD, {n['lld']} LLD, {n['mile']} milestones · {seeded} already ticked in the sheet")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
