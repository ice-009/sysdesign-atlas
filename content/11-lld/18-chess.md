---
title: Design a Chess Game
summary: The hardest of the game problems — pieces that each move their own way, a board, the one rule that makes legality simple (a move is legal only if your own king is safe afterwards), check, checkmate and stalemate, the three special moves, and undo.
difficulty: Hard
scope: LLD
tags: [lld-problem, game, polymorphism, command]
prereqs: [snake-and-ladder, design-patterns]
unlocks: Using polymorphism where it genuinely fits, separating "how a piece moves" from "what's legal right now", and keeping enough game state to undo any move.
---

:::predict Guess first
1. A bishop is pinned to its king by an enemy rook. Do you need special "pinned piece" logic to stop it moving off the line?
2. Rook, bishop and queen all slide until blocked. How much movement code do they need between them?
3. To undo a move, is moving the piece back to its old square enough?
:::

Chess is a favourite for senior LLD rounds because the problem is familiar and the rules are deep. Nobody expects a chess engine in 45 minutes. The interviewer wants three things: **pieces modelled with polymorphism that pulls its weight**, a clean way to decide whether a move is legal, and a sensible answer for the awkward rules — castling, en passant, promotion. This page gives you all three in the order you'd present them.

## 1 · Requirements (0–5)

**Ask first:** two humans on one device, or online? Full rules including castling and en passant? Clocks? A computer opponent?

Assume: two players, full standard rules, move history and undo. No clocks or computer opponent (both are extensions).

**What it must do**
- Show the board; players alternate moves, White first.
- Accept only legal moves, including captures.
- Detect check, checkmate and stalemate.
- Support castling, en passant and pawn promotion.
- Keep the move history; undo the last move.
- End on checkmate, stalemate, resignation or agreed draw.

**Qualities that shape the design**
- **Illegal moves are impossible**, not just discouraged.
- **Each piece's movement lives with that piece**; the rules that involve the whole board live in one place.
- **Every move can be undone exactly** — including captured pieces and lost castling rights.

## 2 · Classes (5–12)

```diagram
   Game          board, players, side to move, status, history
   Board         8×8 grid of Piece-or-empty;  pieceAt(Position), move(...)
   Position      file a–h, rank 1–8      immutable value object
   Piece         colour;  candidateMoves(board, from)        «abstract»
                   King, Queen, Rook, Bishop, Knight, Pawn
   Move          from, to, piece, captured?, kind, promotion?
   Rules         legalMoves(state), isInCheck(colour), isAttacked(square, byColour)
   GameState     board, side to move, castling rights, en-passant square, counters
   History       stack of Moves (with what's needed to undo each)

   enum MoveKind   { NORMAL, CAPTURE, CASTLE_SHORT, CASTLE_LONG,
                     EN_PASSANT, PROMOTION }
   enum GameStatus { IN_PROGRESS, CHECKMATE, STALEMATE, RESIGNED, DRAW }
```

Notice `GameState`. A chess position is *more than the board*: whose turn it is, whether each side may still castle, and whether an en passant capture is possible right now. All of it affects which moves are legal, so it all belongs together. (This is exactly what the standard text notation for a position — FEN — records, if you want to mention it.)

## 3 · Pieces — polymorphism that earns its keep (12–20)

Each piece answers one question: *from this square, where could I go, ignoring check?* Those are **candidate moves**.

Three of the pieces move the same way — sliding in a direction until something's in the way. Give them shared code instead of copying it three times:

```java
abstract class Piece {
    final Colour colour;
    abstract List<Move> candidateMoves(Board b, Position from);
}

abstract class SlidingPiece extends Piece {
    abstract int[][] directions();

    List<Move> candidateMoves(Board b, Position from) {
        List<Move> out = new ArrayList<>();
        for (int[] d : directions()) {
            Position p = from.offset(d[0], d[1]);
            while (p != null) {                           // null = off the board
                Piece there = b.pieceAt(p);
                if (there == null) out.add(Move.normal(from, p, this));
                else {
                    if (there.colour != colour)
                        out.add(Move.capture(from, p, this, there));
                    break;                                // blocked either way
                }
                p = p.offset(d[0], d[1]);
            }
        }
        return out;
    }
}

class Rook   extends SlidingPiece { int[][] directions() { return STRAIGHT; } }
class Bishop extends SlidingPiece { int[][] directions() { return DIAGONAL; } }
class Queen  extends SlidingPiece { int[][] directions() { return ALL_EIGHT; } }

class Knight extends Piece {
    private static final int[][] JUMPS =
        {{1,2}, {2,1}, {2,-1}, {1,-2}, {-1,-2}, {-2,-1}, {-2,1}, {-1,2}};

    List<Move> candidateMoves(Board b, Position from) {
        /* each jump that lands on the board, on an empty or enemy square */
    }
}
```

The `Pawn` is the awkward one — it moves forward but captures diagonally, may move two squares from its starting rank, and promotes on the last rank. It gets its own method; don't try to force it into the sliding pattern.

**Say this:** *"Each piece knows its own movement. Rook, bishop and queen share one sliding routine and differ only in their directions, so adding a fairy piece that slides like a camel would be one line."* That's [open/closed](solid.html) with a concrete example — and polymorphism you can justify.

## 4 · From candidate to legal — the one rule (20–27)

Here's the insight that keeps the design small. A candidate move is **legal if, after making it, your own king is not attacked.** That one test covers every case that confuses people:

- A pinned piece can't move off the line — moving it would expose the king.
- When in check, only moves that end the check survive.
- A king can't step onto an attacked square.

```java
class Rules {
    List<Move> legalMoves(GameState s) {
        Colour me = s.mover();   // apply() flips the turn, so remember who moved
        List<Move> legal = new ArrayList<>();
        // Every piece of the side to move, plus castling:
        for (Move m : candidateMoves(s)) {
            s.apply(m);                                // make it…
            if (!isAttacked(s.board().kingOf(me), me.opponent(), s.board()))
                legal.add(m);
            s.undo();                                  // …and take it back
        }
        return legal;
    }

    boolean isAttacked(Position square, Colour by, Board b) {
        // Look outward from the square. Is there an enemy knight a knight's
        // jump away? A rook or queen along a clear straight line? A bishop or
        // queen on a clear diagonal? A pawn diagonally in front? The king
        // next to it?
    }
}
```

`isAttacked` looks *outward from the square* rather than generating every enemy move — it's faster, and it's simple: about five checks.

:::goat The sentence that makes chess tractable
*"I separate candidate moves — how pieces move — from legal moves. A move is legal only if my king isn't attacked after it. I check that by making the move, testing, and undoing it. That one rule handles pins, getting out of check and the king walking into check, so I don't need special cases for any of them."*

Candidates who try to write "pinned piece" logic directly run out of time. This rule is what you're being tested for.
:::

## 5 · Check, checkmate, stalemate (27–30)

With `legalMoves` and `isAttacked`, the end conditions are three lines:

```java
GameStatus statusAfterMove(GameState s) {
    Colour side = s.mover();
    Position king = s.board().kingOf(side);
    boolean inCheck = rules.isAttacked(king, side.opponent(), s.board());
    boolean canMove = !rules.legalMoves(s).isEmpty();
    if (canMove) return GameStatus.IN_PROGRESS;
    return inCheck ? GameStatus.CHECKMATE : GameStatus.STALEMATE;
}
```

**Checkmate:** in check and no legal moves. **Stalemate:** *not* in check, but still no legal moves — a draw. Getting stalemate right is a small detail interviewers notice; many candidates forget it exists.

## 6 · The three special moves (30–37)

Each needs a little extra state. That's why `GameState` exists.

**Castling.** The king moves two squares toward a rook and the rook jumps over it. Allowed only if:
- neither the king nor that rook has moved yet — tracked as four *castling rights* in `GameState`, removed the first time a king or rook moves (or a rook is captured);
- the squares between them are empty;
- the king is not in check, and doesn't pass through or land on an attacked square.

```java
if (s.canCastleShort(mover)
    && board.isEmpty(f1) && board.isEmpty(g1)
    && !rules.isAttacked(e1, enemy, board)
    && !rules.isAttacked(f1, enemy, board)
    && !rules.isAttacked(g1, enemy, board)) {
    candidates.add(Move.castleShort(mover));
}
```

**En passant.** If a pawn moves two squares and lands beside an enemy pawn, that enemy pawn may capture it *as if it had moved one* — but **only on the very next move**. So `GameState` stores an *en passant square*, set after any two-square pawn move and cleared after the next move. The captured pawn isn't on the destination square, which is why the `Move` needs its own kind: undo must put it back in the right place.

**Promotion.** A pawn reaching the last rank becomes a queen, rook, bishop or knight — the player chooses. One `Move` per choice; the UI asks, and defaults to queen.

## 7 · Undo, and why moves are objects (37–41)

Each move is an object that knows how to apply and reverse itself — the **command pattern**. Reversing needs more than "move the piece back": you must restore the captured piece, the castling rights and the en passant square as they were.

```java
record Move(Position from, Position to, Piece piece, Piece captured,
            MoveKind kind, PieceType promotion) {}

record UndoInfo(Move move, CastlingRights rightsBefore,
                Position enPassantBefore, int halfmoveClockBefore) {}

class GameState {
    private final Deque<UndoInfo> history = new ArrayDeque<>();

    void apply(Move m) {
        history.push(new UndoInfo(m, castling, enPassant, halfmoveClock));
        // execute() also handles castling's rook, en passant's pawn, promotion
        board.execute(m);
        castling = castling.after(m);
        enPassant = m.isDoublePawnPush() ? m.passedSquare() : null;
        sideToMove = sideToMove.opponent();
    }

    void undo() {
        UndoInfo u = history.pop();
        board.reverse(u.move());    // put back the piece and any captured one
        castling = u.rightsBefore();
        enPassant = u.enPassantBefore();
        halfmoveClock = u.halfmoveClockBefore();
        sideToMove = sideToMove.opponent();
    }
}
```

The same history gives you the move list for display and a way to replay a whole game. And `legalMoves` in section 4 uses exactly this apply/undo pair — the undo feature and the legality check share one tested piece of code.

## 8 · Extensions

**"Add a chess clock."**
> "A `Clock` per player, and a `TimeControl` strategy — 10 minutes flat, or 3 minutes plus 2 seconds per move. The game asks the clock after each move; running out of time is one more `GameStatus`."

**"Play against the computer."**
> "Make `Player` an interface with `HumanPlayer` and `ComputerPlayer`. The computer calls the same `legalMoves` and picks one — choosing well is a search algorithm, separate from this design. The rules don't know who is moving."

**"Play online."**
> "The server owns the `GameState` and validates every move with the same `Rules`; clients only send 'from, to'. Never trust a client to tell you a move is legal."

**"Draw by repeating the same position three times."**
> "Keep a count per position. A position is the board plus side to move, castling rights and en passant square — the same `GameState` fields. Hash it (chess programs use a technique called Zobrist hashing so each move updates the hash cheaply) and count."

:::exercise Test the one rule
Set up: White king e1, White rook e2, Black rook e8, Black king h8. White to move.

1. List the rook's candidate moves. Which are legal, and why? (It's pinned: only moves along the e-file keep the king covered.)
2. Black's rook captures on e2. Is White in check? Which king moves are legal?
3. Show how the `legalMoves` loop from section 4 rejects White's rook moving to a2, without any code that mentions "pins".
:::

## Check yourself

```recall
Q: What three things does a chess LLD round look for?
A: Polymorphism that earns its keep for pieces, a clean way to decide legality, and sensible handling of castling, en passant and promotion.

Q: Why is GameState more than the board?
A: Legality depends on whose turn it is, the four castling rights and the en passant square too — what FEN records.

Q: How do sliding pieces share code?
A: A SlidingPiece base walks each direction until blocked, capturing an enemy and stopping; Rook, Bishop and Queen differ only in their directions. Knight and Pawn have their own methods.

Q: What one rule turns candidate moves into legal moves?
A: A move is legal only if your own king isn't attacked afterwards — make it, test, undo. That covers pins, escaping check and the king walking into check with no special cases.

Q: How does isAttacked work efficiently?
A: Look outward from the square: enemy knights a jump away, rooks or queens on clear lines, bishops or queens on clear diagonals, pawns diagonally in front, the enemy king adjacent.

Q: Checkmate versus stalemate?
A: Both mean no legal moves. Checkmate: the side to move is in check. Stalemate: not in check — a draw, which many candidates forget.

Q: What extra state do castling and en passant need?
A: Castling rights, lost the first time a king or rook moves or a rook is captured (plus empty, unattacked squares). An en passant square set after a two-square pawn push and cleared after the next move.

Q: How does undo work, and what else uses it?
A: Each move is a command; before applying, push the captured piece, castling rights, en passant square and clocks, so undo restores them exactly. The legality check reuses the same apply/undo pair.
```

## What to carry forward

- Pieces own their movement; sliding pieces share one routine.
- Separate candidate moves from legal moves: legal means your king is safe afterwards.
- GameState holds turn, castling rights and en passant — everything legality depends on.
- Checkmate and stalemate both mean no legal moves; check decides which.
- Moves are commands carrying what undo needs; legality and undo share code.
