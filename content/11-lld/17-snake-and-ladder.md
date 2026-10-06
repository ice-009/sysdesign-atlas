---
title: Design Snake and Ladder
summary: The friendliest LLD problem — a board, players, a die and a turn loop — used to test clean modelling, rules you can swap, a die you can fake in tests, and one insight that shrinks the design: a snake and a ladder are the same thing.
difficulty: Easy
scope: LLD
tags: [lld-problem, game, strategy, testing]
prereqs: [oop-refresher, uml-class-diagrams]
unlocks: Modelling a turn-based game cleanly, and making randomness testable — which carries straight over to chess, card games and simulations.
---

:::predict Guess first
1. A snake goes from square 27 down to 1; a ladder goes from 3 up to 22. Do they need different classes?
2. The game rolls a random die. How would you write a test that checks "rolling a 3 lands on the ladder"?
3. What algorithm would find the fewest rolls needed to finish a given board?
:::

Interviewers use this one as a warm-up, or for a shorter round. There's no concurrency and no money. What they're watching is whether your classes are clean, whether rules that vary are kept apart from the game loop, and whether you think about **testing** — because a game driven by a random die is impossible to test unless you design for it.

:::tip Practise the algorithm on LeetCode
The game has an algorithmic twin: **LC 909 — Snakes and Ladders** (Medium) asks for the fewest dice rolls to finish. Section 6 shows the approach. Do it after the design.
:::

## 1 · Requirements (0–4)

**Ask first:** board size? How many players? One die or two? Must you land exactly on the last square? Does a six give another turn?

Assume: a 10×10 board (squares 1 to 100), 2–4 players, one six-sided die, must land exactly on 100, a six gives one extra roll.

**What it must do**
- Set up a board with snakes and ladders.
- Players take turns: roll, move, slide down a snake or climb a ladder.
- The first to reach 100 wins.
- Show each move ("Asha rolled 4: 23 → 27, ladder to 56").

**Qualities that shape the design**
- **Rules are swappable**: exact finish or not, extra turns or not, number of dice.
- **Testable**: a test must be able to say "the die rolls 4, then 6, then 1."
- **The board is valid**: no snake on square 100, no loops.

## 2 · Classes (4–10)

```diagram
   Game          board, players (in turn order), dice, rules, status, winner?
   Board         size, jumps: Map<from, to>
   Player        name, position (everyone starts on square 1)
   Dice          roll()               «interface»  RandomDice, FixedDice, TwoDice
   Rules         finishing rule, extra-turn rule «interface»
   MoveResult    player, rolled, from, to, jump?, won
   enum GameStatus { NOT_STARTED, IN_PROGRESS, FINISHED }
```

The insight that simplifies everything — say it early:

:::goat A snake and a ladder are the same object
Both say "if you land on square A, go to square B." A ladder has B > A; a snake has B < A. So the board needs **one map, `jumps: from → to`**, not two lists and two loops. Moving a player is one lookup.

*"I'm modelling snakes and ladders as a single `Jump` from one square to another — direction is the only difference, and it falls out of the numbers."* Small, but it shows you look for the simplest model, not the most literal one.
:::

## 3 · The turn loop (10–18)

```java
class Game {
    private final Board board;
    private final List<Player> players;
    private final Dice dice;
    private final Rules rules;
    private int turn = 0;
    private GameStatus status = GameStatus.NOT_STARTED;
    private Player winner;

    MoveResult playTurn() {
        if (status == GameStatus.FINISHED)
            throw new IllegalStateException("game over");
        status = GameStatus.IN_PROGRESS;

        Player p = players.get(turn);
        int rolled = dice.roll();
        int from = p.position();
        // The exact-finish rule lives in Rules; the jumps live in Board.
        int target = rules.landing(from, rolled, board.size());
        int to = board.resolve(target);              // slide or climb
        p.moveTo(to);

        boolean won = to == board.size();
        if (won) { status = GameStatus.FINISHED; winner = p; }
        else if (!rules.extraTurn(rolled)) turn = (turn + 1) % players.size();

        return new MoveResult(p, rolled, from, to, board.jumpAt(target), won);
    }
}

class Board {
    private final int size;
    private final Map<Integer, Integer> jumps;

    int resolve(int square) { return jumps.getOrDefault(square, square); }
}
```

`playTurn()` returns a `MoveResult` instead of printing. That's deliberate: the game logic doesn't know about screens. A console UI prints the result, a web UI animates it, and a test asserts on it — one source of truth.

## 4 · Rules and dice — where things vary (18–25)

Two things the interviewer will vary, so give each an interface.

```java
interface Rules {
    int landing(int from, int rolled, int last);
    boolean extraTurn(int rolled);
}

class ClassicRules implements Rules {
    public int landing(int from, int rolled, int last) {
        int target = from + rolled;
        return target > last ? from : target;    // overshoot: stay put
    }
    public boolean extraTurn(int rolled) { return rolled == 6; }
}

class EasyRules implements Rules {                     // for small children
    public int landing(int from, int rolled, int last) {
        return Math.min(from + rolled, last);
    }
    public boolean extraTurn(int rolled) { return false; }
}
```

And the die — this is the testing point:

```java
interface Dice { int roll(); }

class RandomDice implements Dice {
    private final Random random;
    // Pass in a seeded Random to replay a real game exactly.
    RandomDice(Random random) { this.random = random; }
    public int roll() { return random.nextInt(6) + 1; }
}

class FixedDice implements Dice {                          // for tests
    private final Iterator<Integer> rolls;
    FixedDice(int... rolls) { this.rolls = Arrays.stream(rolls).iterator(); }
    public int roll() { return rolls.next(); }
}
```

```java
@Test void ladderThenWin() {
    Board b = new Board(100, Map.of(4, 56, 99, 2));   // ladder 4→56, snake 99→2
    Game g = new Game(b, players("Asha", "Ravi"),
                      new FixedDice(3, 2), new ClassicRules());
    assertEquals(56, g.playTurn().to());   // Asha: 1 + 3 = 4, climbs to 56
    assertEquals(3, g.playTurn().to());    // Ravi: 1 + 2 = 3, no jump
}
```

**Say this:** *"Randomness comes in through an interface, so tests can script the rolls and a seeded random can replay a real game. It's dependency inversion — the game depends on 'something that gives numbers', not on `Math.random()`."* That links a simple game to [SOLID](solid.html) in one sentence.

## 5 · A valid board (25–30)

Set-up is where bugs hide. `Board`'s constructor checks:

```java
Board(int size, Map<Integer, Integer> jumps) {
    for (var j : jumps.entrySet()) {
        int from = j.getKey(), to = j.getValue();
        if (from <= 1 || from >= size)
            throw bad("a jump can't start on the first or last square");
        if (to < 1 || to > size || to == from)
            throw bad("jump " + from + "→" + to + " is out of range");
        if (jumps.containsKey(to))
            throw bad("jump " + from + " lands on another jump's start");
    }
    this.size = size;
    this.jumps = Map.copyOf(jumps);
}
```

The third check is the subtle one. If a ladder ends where a snake starts, do you follow both? Banning it keeps `resolve()` a single lookup and rules out loops — a ladder up to a snake back to the ladder. If the interviewer wants chains, resolve in a loop with a visited set. Either way, *say which you chose.*

## 6 · The algorithm question (30–37)

The follow-up: *"what's the fewest rolls needed to finish this board?"* — LC 909. Each square is a node; from each square there are up to six edges (rolls 1–6), each ending where the jump at that square sends you. The fewest rolls is the **shortest path** in an unweighted graph, which is breadth-first search.

```java
int fewestRolls(Board b) {
    int n = b.size();
    int[] rolls = new int[n + 1];
    Arrays.fill(rolls, -1);
    Deque<Integer> q = new ArrayDeque<>();
    rolls[1] = 0;
    q.add(1);
    while (!q.isEmpty()) {
        int sq = q.poll();
        if (sq == n) return rolls[n];
        for (int d = 1; d <= 6 && sq + d <= n; d++) {
            int next = b.resolve(sq + d);
            if (rolls[next] == -1) { rolls[next] = rolls[sq] + 1; q.add(next); }
        }
    }
    return -1;                       // unreachable (possible on an evil board)
}
```

O(n) squares × 6 rolls — linear. The LeetCode version adds one twist: the board is given as a grid numbered in a zigzag (left to right on the bottom row, right to left on the next). Convert square number → row and column, then it's this same BFS.

## 7 · Extensions

**"Undo the last move, or replay a game."**
> "Each turn is already a `MoveResult`. Keep them in a list — that's a history you can replay, and undo is moving the player back to `from`. Turning each move into an object you can store and reverse is the command pattern."

**"Play online with friends."**
> "The `Game` stays the same and runs on the server, which rolls the die — never trust the client's roll. Clients send 'roll' and receive `MoveResult` events."

**"Two dice, or special squares that give a free turn."**
> "Two dice is a `TwoDice` that sums two rolls. Special squares are a new kind of cell effect alongside jumps — the board resolves a landing into an effect, and the game applies it."

:::exercise Play it in your head
Board: ladders 3→22, 8→30; snakes 27→1, 21→9. Players Asha and Ravi start on square 1. Classic rules; the die rolls 2, 6, 1, 5, 4 in order.

1. Write each `MoveResult`. Who rolls when, given that a six gives another turn?
2. What should `fewestRolls` return for a 30-square version of this board?
3. Someone adds a ladder 9→27. Why does the board constructor refuse it?

(1: Asha 1→3, ladder to 22. Ravi 1→7, rolled a six so rolls again: 7→8, ladder to 30. Asha 22→27, snake to 1. Ravi 30→34. 2: two rolls — a 1 then a 6 reaches square 8 and its ladder to 30. 3: 27 is where a snake starts.)
:::

## Check yourself

```recall
Q: What insight simplifies the Snake and Ladder board?
A: A snake and a ladder are the same thing — a jump from square A to square B. One Map<from, to> covers both, and moving is one lookup.

Q: Why does playTurn() return a MoveResult instead of printing?
A: The game logic doesn't know about screens: a console prints it, a web UI animates it and a test asserts on it — one source of truth.

Q: Which two things vary, and how are they modelled?
A: The rules (exact finish, extra turn on a six) behind a Rules interface, and the die behind a Dice interface — RandomDice, FixedDice, TwoDice.

Q: How do you make a random game testable?
A: Inject the die: FixedDice scripts the rolls in tests, and a seeded Random replays a real game exactly. It's dependency inversion applied to randomness.

Q: What must the Board constructor reject?
A: Jumps starting on the first or last square, jumps out of range or to themselves, and a jump ending on another jump's start — which would create chains or loops.

Q: How do you find the fewest rolls to finish (LC 909)?
A: BFS over squares: each square has up to six edges (rolls 1–6) ending wherever the jump sends you. Shortest path in an unweighted graph, O(n × 6).

Q: How do undo and replay fit?
A: Keep the list of MoveResults: replay walks it, undo moves the player back to "from" — the command pattern.
```

## What to carry forward

- Look for the simplest model: snakes and ladders are both jumps.
- Return results, don't print — keep game logic free of UI.
- Rules and dice vary; inject the die so tests can script it.
- Validate the board at construction so the game loop stays simple.
- Fewest rolls is BFS on an unweighted graph.
