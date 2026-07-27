---
title: "You can't judge retrieval by the answer"
description: My plan was to use a RAG bot to pressure-test my semantic search. That plan was a confounded experiment — a weak model fails on good context, a strong model succeeds despite bad context, and either way you learn nothing about retrieval. The fix wasn't a bigger model. It was logging what got retrieved.
---

I'd built semantic search over my chat project's history — every message embedded with `all-minilm`, stored as a 384-dimension vector in pgvector, searched by cosine distance. It worked, in the sense that the plumbing was correct. Whether it was any *good* was another question, and on a corpus of eight test messages I had no way to tell.

So my plan was: build the RAG `@bot` next, and let it apply pressure. When the bot answers wrong, I'd learn which retrieved message misled it, and that would tell me whether to invest in hybrid search.

That plan has a hole in it, and I only saw it when someone asked whether a smaller model would still serve the purpose.

## The confound

When a RAG bot gives a bad answer, there are two possible causes:

1. **Retrieval handed it the wrong messages.** Fixing retrieval would help.
2. **Retrieval handed it the right messages and the model couldn't use them.** Fixing retrieval would help *not at all*.

Judging by answer quality can't distinguish these. And it gets worse, because the error runs in **both** directions depending on model size:

- A **weak model** fumbles even perfect context, so good retrieval looks broken.
- A **strong model** often answers correctly *despite* terrible retrieval, because it already knows the answer from training. It papers over retrieval failures with its own parametric knowledge.

That second one is the trap I'd have walked into if I'd reached for a bigger model to make the test "more valid." For evaluating a *retriever*, a model that can improvise around missing information isn't a better instrument — it's a blindfold.

You're testing whether a grocery delivery service brings the right ingredients, and you're grading it on how the meal tasted. A brilliant cook improvises around what's missing. A bad one ruins a perfect delivery. Either way you've learned nothing about the delivery.

## The fix is instrumentation, not a bigger model

Retrieval produces a ranked list **before** generation happens. You can just look at it. So the bot now logs exactly what it retrieved, with scores, before the model sees anything:

```text
question from omkar in room 1: "is the persister down btw?"
retrieved 10 candidates:
  [1] 86% omkar: the persister is down intentionally now bro!
  [2] 83% omkar: okay so i think the persister is configured now, right?
  [3] 67% omkar: @bot what happened with the persister?
  [4] 67% omkar: @bot what happened with the persister?
  [5] 61% bot: The persister was intentionally turned off by Omkar.
  [6] 53% omkar: yup 2nd msg after i intenionally shut down that mfer persister!
  [7] 24% omkar: this is another new message btw!
using 3 of 10 as context (top 86%)
```

Now a bad answer is **attributable**. If the answering message is in that list, retrieval worked and the model fumbled it. If it isn't, that's a retrieval failure and hybrid search is justified. No guessing.

And this works with *any* model size — which means the weak model I was worried about is actually fine. `qwen2.5:1.5b` knows nothing about my chat history, so it can't fake it. It leans almost entirely on what I hand it, which makes it a **more sensitive detector** of bad context than a big model would be.

## What the logs immediately told me

Two questions, same corpus, same model:

| Question | Top real hit | Answer |
|---|---|---|
| "is the persister down btw?" | **86%** | correct |
| "why did the messages survive?" | **38%** | **hallucinated** |

The second answer was *"The messages survived because they were intentionally saved by Omkar."* They didn't — they survived because Kafka's durable log held them while the persister was down. The model saw *"i intentionally shut down that mfer persister"* and mangled "intentionally shut down" into "intentionally saved."

**And the log proves this is a generation failure, not a retrieval failure.** Reading the corpus: there is **no message anywhere** that explains why messages survived. Retrieval did its job — it surfaced the only vaguely relevant things that exist. The answer simply isn't in the data.

Which means hybrid search, the thing I was about to go build, would have contributed **exactly nothing** to this failure. That's the whole return on the instrumentation: it stopped me optimising the wrong component.

## Two other things the logs surfaced

**Embeddings are close to blind to negation.** An early test query was `"no data was lost"`. The top hits came back as the most *failure*-flavoured messages in the room — the persister being shut down. Because `"no data was lost"` and `"data was lost"` embed almost identically: the word "no" barely moves the vector while completely inverting the meaning. This is a known property of sentence embeddings, and it's the single strongest argument for eventually blending in keyword search, which handles negation, proper nouns and exact identifiers that dense vectors fumble.

**The bot was citing itself.** Look at `[5]` in that log: `bot: The persister was intentionally turned off by Omkar.` — the bot's own previous answer, retrieved at 61% as *evidence* for a new question. Its replies go into the same log the indexer reads, so they get embedded like anyone's. Left alone, the bot would ground new answers in old generated text and compound its own errors. It now filters out its own messages, the asking message, and anything below a similarity floor.

That's a failure mode I'd never have predicted from the outside, and it was sitting there in plain text on line five.

## Refusing in code instead of asking nicely

My system prompt already said: *"If the excerpts do not contain the answer, say you don't know — do not guess."* The model ignored it. Small models are weak at refusing; they'd rather produce something plausible.

But look at that table again — **86% correct, 38% hallucinated**. That's a clean signal sitting right there in the retrieval scores. So rather than hoping the model obeys an instruction, I gate on it:

```go
if kept[0].Similarity < minTopSimilarity {   // 0.50
    return "I don't have enough in this room's history to answer that confidently.", nil
}
```

Refusal is now **deterministic**. It's also free latency — we skip ~10 seconds of generating an answer that was going to be wrong.

Instead of asking someone to guess and hoping they admit ignorance, check whether the file is even in the cabinet before you ask.

**One subtlety that took a moment to get right:** the gate reads `kept[0]`, not `hits[0]`. The raw top hit is frequently *the asking message itself* — near-identical text scores ~80% against its own embedding. Gating on that would be **false confidence from an echo**. `kept` has already had mentions and the bot's own replies stripped, so `kept[0]` is the best real evidence available.

## The honest caveats

- **0.50 is fitted to roughly ten data points.** It's the right *shape* of solution and a guessed *magnitude*. On a real corpus with a real query set it would move.
- **The threshold only works because there's a gap to threshold on.** An earlier query, `greeting`, produced a smooth slope — 31 / 25 / 22 / 17 / 15 — with the correct answer beating generic filler by six points. No cliff, so no cutoff can separate signal from noise. The persister query produced 86 / 83 / 53 / **16** — an obvious cliff. Separation appears when the corpus genuinely contains relevant content, and vanishes when it doesn't.
- **I still have no evaluation harness**, and that's the real blocker. A fixed query set with expected hits is what turns all of the above from anecdote into measurement. Everything here rests on a handful of ad-hoc test messages, which is not enough to conclude much. I built exactly that for my news feed's search — [hybrid search and the honest eval](/projects/hybrid-search-and-the-honest-eval/) — and then didn't carry the habit over to a new project, which is its own small lesson.
- **A confidence gate is not a correctness gate.** It catches "the answer isn't in the corpus." It does nothing about a model misreading context that *is* there.

## The lesson

The instinct to test one component through another is natural and often wrong. I was going to evaluate a retriever by reading the output of a language model that sits downstream of it — two systems, one number, no way to attribute a failure to either.

The fix cost about six lines of logging and it changed what I could learn. **Log the intermediate, not just the output.** In any pipeline where stage B consumes stage A, the thing you most need to see is what A actually handed over — because that's the only place the two can be told apart.

And the thing I'd have got wrong without it: I'd have concluded my search needed hybrid retrieval, spent a weekend building it, tuned blend weights against eight messages, and shipped a more complicated system that fixed nothing. The bug was never in retrieval. Retrieval was doing fine.
