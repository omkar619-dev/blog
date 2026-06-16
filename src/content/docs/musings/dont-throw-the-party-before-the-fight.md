---
title: Don't Throw the Party Before the Fight
description: Ilia Topuria celebrated his win the night before he lost it. On confidence, the difference between being ahead and being safe, and why "victory is already ours" is the most dangerous sentence in sport.
---

The night before he fought Justin Gaethje on the White House lawn, Ilia Topuria threw a party.

Not a quiet dinner with his coaches. A full celebration — family, friends, supporters packed into a restaurant in Washington, Oleksandr Usyk in the room, the whole place singing his name. And Topuria, undefeated and apparently untouchable, stood up and said it out loud, in Spanish, for everyone to hear: *"It's not a victory we have to earn. Victory is already ours."*

Twenty-four hours later his corner threw in the towel between the fourth and fifth rounds, his face swollen shut, the title gone, the undefeated record gone with it.

You could write the cheap version of this story in your sleep. *Arrogant champion gets humbled.* Ego writes a cheque the chin can't cash. It's a satisfying little morality play and it would take about four hundred words. The problem is it isn't true — or at least, it's nowhere near the whole truth, and the part it leaves out is the part that actually has something to teach.

Because here's what really happened: **Topuria didn't get blown out. He was winning.**

## He was ahead

Round one, he walked Gaethje down, out-landed him, and wobbled him. This wasn't a man getting picked apart at range — this was the favourite imposing himself exactly like everyone expected. Round two was even better for him: he turned the screws, threatened the finish, landed something like 57 significant strikes to Gaethje's 14, and had the toughest man in the division covering up and surviving. If a freak cut had stopped the fight at the midway point, we'd be talking about a routine coronation and the party would look like prophecy.

And then it flipped. Not in one dramatic moment — that's the thing people misremember about fights like this. There was no single highlight-reel knockdown that turned it. Gaethje is one of the most violently durable human beings the sport has ever produced, a man who has built an entire career on the principle that you cannot win a fight he refuses to stop being in. He kept pumping the jab. Kept landing the uppercut. Kept walking through what would have finished almost anyone else. And somewhere across the third and fourth rounds, the fight quietly changed owners — through accumulation, through attrition, through the slow leak of a lead against a man who simply would not accept that he was behind.

Topuria was ahead. He was never safe. Those are not the same thing, and the entire fight lived in the gap between them.

## The most dangerous sentence in sport

*"Victory is already ours."*

I keep circling back to that line, because it isn't just pre-fight theatre. It's a worldview. And it happens to be the precise worldview that loses championship rounds.

The moment you decide the result is settled, something subtle switches off. You stop doing the unglamorous, grinding work that *produces* the result, because in your head the result already exists. You stop respecting the danger in front of you, because danger implies the outcome is still in question and you've already closed that question. You coast — not consciously, not lazily, but in the way a man coasts when he's certain the finish line is behind him. And against an opponent who hasn't read the script, who hasn't agreed to play his assigned role in your celebration, coasting is fatal.

The cruelest detail, and the one that turns this from a one-off into something worth writing about: **Topuria does this every time.** He held the same kind of pre-fight celebration before he fought Charles Oliveira. It worked. He won. So the habit got rewarded, reinforced, written into the legend — *this is just what a champion looks like, this is the swagger of a man who knows.*

That's the real trap, and it's worth sitting with. **Overconfidence almost never shows up looking like a flaw. It shows up disguised as a winning streak.** Every time it doesn't punish you, it gets a little more entrenched, a little more invisible, a little more like wisdom. The behaviour that looks like earned confidence right up until the night it betrays you is *the same behaviour the whole way through* — you just can't tell the difference from the inside until the bill comes due. Topuria was carrying that loaded gun into every camp. It only went off once. That doesn't mean it was safe the other times.

## What this actually has to do with the rest of us

I don't run into octagons. I write backend code, I deploy things at one in the morning, and I occasionally get to watch them fall over in production in real time. Different arena, identical failure mode — and I've lived the small, embarrassing version of it more than once.

You ship the feature. It works. It works again the next day. Traffic's fine, the dashboards are green, and somewhere in your head a switch flips: *this one's done.* So you stop writing the tests for the awkward edge cases. You stop tailing the logs. You stop sanitising the input you "know" is always going to be well-formed. You quietly assume the dependency will hold, the queue won't back up, the load you never actually tested will behave like the load you imagined. Victory is already ours.

And then the durable, boring, relentless thing you stopped respecting just keeps jabbing. The one malformed payload. The slow memory leak. The third-party API that finally times out under real concurrency. None of it is dramatic. None of it is a single knockout blow. It's accumulation — your lead leaking away at the worst possible moment, against an opponent (entropy, scale, the real world) that never agreed to lose.

Being ahead — in a project, an interview loop, a career, a relationship — *feels* like safety. That's the lie at the centre of all of this. It isn't safety. It's a position you have to keep actively defending against something that hasn't conceded. The work that got you ahead is the exact same work that keeps you there, and the instant you start celebrating is the instant you stop doing it. Nobody loses the lead while they're still fighting for it. You lose it the moment you decide you've already won.

## The honest closer

Let me be fair, because I'd want someone to be fair to me. Confidence didn't beat Ilia Topuria. **Justin Gaethje did** — a 37-year-old veteran who walked through the best two rounds of a younger, faster, undefeated champion and refused to break, then methodically took him apart when it counted. That is a brilliant, brutal performance and it deserves to be remembered as a thing Gaethje *won*, not just a thing Topuria lost. I'm wary of any story that turns a great man's triumph into a footnote about somebody else's ego.

But the lesson sits right there next to the result anyway, and I'm not going to pretend it doesn't: **don't throw the party before the fight.** Earn it, then celebrate it — in that order, and never the reverse. Stay humble while you're still ahead, because being ahead is precisely the moment you can least afford not to be. The danger doesn't disappear when you start winning. It just gets quieter, and waits.

Topuria will be back. He's far too good not to be, and I suspect this loss will make him more dangerous, not less. But I'd put money on one thing: next time, he books the restaurant *after*.

— *Just some thoughts between deploys.*
