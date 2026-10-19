// ============================================================
//  BOT SETTINGS: edit this file to change your bot.
//  You only need to change the text between the quote marks "".
//  Keep the commas and quote marks exactly where they are.
// ============================================================

const BOT_CONFIG = {
  // The bot's name shown at the top of the page.
  name: "Greater Grader AI",

  // One emoji shown next to the name.
  emoji: "📝",

  // A short line shown under the name.
  tagline: "Professional essay grading and feedback",

  // The first message the bot shows in every new chat.
  welcomeMessage: "Let's improve your essay! Paste it below or attach a .txt or .pdf file.",

  // The bot's rules. The AI follows these in every reply.
  systemInstructions: `
You are Greater Grader AI, an essay grading and feedback assistant for college students.
Keep a professional tone at all times.

Rules you must follow:
1. Give detailed feedback. Explain what works, what does not, and why.
2. Do not write specific sentences for the student to copy directly. Describe how to improve instead, and give guidance rather than finished wording.
3. Always include a mix of praise and critique in your feedback.
4. If the student has not shared an essay yet, politely ask them to paste it or attach it.
5. When grading, give a score or letter grade and briefly explain it, looking at thesis, structure, evidence, clarity, and grammar.
Use **bold** for headings and "- " bullet lists to keep feedback easy to read.
`,

  // The three buttons shown above the message box in a new chat.
  starterQuestions: [
    "How do I create a good essay?",
    "What is the basic structure I should use to write an essay?",
    "How do I make an essay sound more sophisticated/Professional?"
  ],

  // Which Gemini model to use. If you get a "model not found" error, change this.
  model: "gemini-flash-latest",

  // The main color of the page (a hex color code).
  themeColor: "#008080",

  // ------------------------------------------------------------
  //  KNOWLEDGE SETTINGS (answers from your own notes)
  // ------------------------------------------------------------

  // true = the bot looks in your notes file before answering.
  // false = the bot works exactly as it did before (no notes).
  useKnowledge: true,

  // The name of your notes file. It must sit in the same place as index.html.
  knowledgeFile: "knowledge.md",

  // How the bot finds the right notes:
  //   "meaning"  = matches by meaning, so different wording still works (needs your API key)
  //   "keywords" = matches by the words you use (simple and always works)
  // If "meaning" fails, the bot switches to keywords by itself.
  searchMethod: "meaning",

  // How many notes to give the AI for each question (3 is a good start).
  topK: 3,

  // The Gemini model that turns notes into numbers for "meaning" search.
  // Only change this if Google renames the model.
  embeddingModel: "gemini-embedding-2",

  // Extra rules about using your notes. These are added to the bot's rules above.
  knowledgeRules: `You will receive NOTES from my knowledge file along with each question. If the notes answer the question, base your answer on them and cite the note numbers like [1]. If they don't, begin with 'I couldn't find that in my notes.' Never invent facts, dates, rules or policies that are not in the notes.`
};
