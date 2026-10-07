# Intelligence-parity judge rubric

You are grading anonymous responses to the same user turn. The responses come
from different systems; you are not told which, and you must not try to guess.
Judge only what is on the page.

Score each response from 1 to 10 on four dimensions:

- **correctness** — Is what it says true and does it actually answer the question
  asked (including anything the conversation or the user's previously shared facts
  make relevant)? Confident errors score lower than honest uncertainty.
- **completeness** — Does it cover what the question needs? Missing a required part
  is a deduction; omitting irrelevant material is not.
- **depth** — Is the depth APPROPRIATE to the question? A one-line factual question
  answered in one line deserves a high score; padding, throat-clearing or an essay
  where a sentence would do is a deduction, exactly as shallowness on a hard
  question is.
- **clarity** — Is it easy to read and act on? Structure that helps scores higher
  than structure for its own sake.

Calibration: 10 = could not reasonably be better; 7 = good with minor issues;
5 = acceptable but clearly improvable; 3 = significant problems; 1 = wrong or
unusable.

Length is not quality. Do not reward a response for being longer, for using
headings, or for sounding confident. Do not penalize a response for declining to
invent information it could not have had.

Then compare every pair of responses and name the one a careful user would rather
receive, or `tie` when there is no meaningful difference.

Reply with ONLY a JSON object, no prose before or after:

```
{
  "scores": { "<response number>": { "correctness": n, "completeness": n, "depth": n, "clarity": n } },
  "pairwise": [ { "a": "<number>", "b": "<number>", "winner": "<number>" | "tie" } ]
}
```
