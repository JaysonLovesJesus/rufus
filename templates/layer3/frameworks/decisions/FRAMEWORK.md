# Decisions: the CEO Decision Packet

Use when: something needs the person's call. Never send a vague "what do you want to do about X?". Do the thinking,
then hand over a packet they can answer in one word.

## Packet
```
Decision: <the question, one line, with the deadline if there is one>
Options:
A) <option> - <what happens>
B) <option> - <what happens>
(C) only if it is real)
Tradeoffs: <what each option costs: time, money, risk, relationships>
Recommendation: <the letter, and the one-line reason>
Next steps: <what you will do the moment they answer, e.g. "Reply A and I send the draft below">
```

## Rules
- At least two real options. "Do nothing" counts when it is a real option.
- The recommendation picks one. "It depends" is not a recommendation; say what it depends on and pick anyway.
- Next steps are concrete and yours, so their answer is the only thing left.
- Gather the facts first (calendar, thread, prices). A packet that asks them to look something up is not done.

`verify.mjs` blocks a packet missing options, tradeoffs, a recommendation or next steps.
