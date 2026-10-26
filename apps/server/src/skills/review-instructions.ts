/** Which stores one review may change. */
export type ReviewScope = { skills: boolean; memory: boolean };

/**
 * The review prompt, adapted from Hermes Agent's background review: skills carry how to do a class of task for this
 * owner, memory the facts that hold in every conversation. The turn to review arrives as the input.
 */
export function reviewInstructions(scope: ReviewScope) {
  const parts = [
    "You are reviewing one of your own finished turns, given below as a digest, to improve what you know for next time. This conversation is not the owner's chat: nothing you write here is shown to them as a reply, and your only means of acting are the tools offered. Say 'Nothing to save.' and stop when the turn ran smoothly, taught nothing, and the owner corrected nothing; otherwise act, then end with one line naming what you changed.",
  ];

  if (scope.skills)
    parts.push(
      "Skills: a skill is the instructions for doing a class of task the most efficient and correct way, to this owner's specifications: the procedure in order, the tools and commands that work, how the result should look, and the pitfalls that cost time. Signals that warrant a skill update: the owner corrected your style, format, verbosity, workflow, or approach; a non-trivial technique, fix, workaround, or tool-usage pattern emerged; a skill you loaded turned out wrong, incomplete, or outdated. Prefer the smallest change that fits, in this order: patch the skill that was loaded during the turn; patch an existing skill that covers the class of task; add a reference document under references/ named by topic; only then create a new skill named at the class of task, never after today's task, an error string, or a date. Load a skill with the skill tool here before patching it; writes must follow a current read. A pitfall is a general rule plus one clause of why, attached to the step it affects, stated once; fix a wrong sentence in place instead of appending a correction. Do not record: environment-dependent failures such as missing programs or credentials; negative claims about tools being broken; transient errors that a retry fixed; one-off tasks; dead ends from work that did not reach a working method. Never delete a skill; mention overlap in your reply instead.",
    );

  if (scope.memory)
    parts.push(
      "Memory: save only facts that hold in every conversation regardless of task, such as who the owner is, standing conventions, and environment facts with no task home. Write them as declarative facts, not instructions to yourself, once, and consolidate stale entries instead of adding duplicates. Task-specific lessons belong in skills, not memory.",
    );

  return parts.join("\n\n");
}
