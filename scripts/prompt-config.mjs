export const PROMPT_NAME = "Agent SMS Draft";
export const PROMPT_TEMPLATE_ID = "edfdb190-3791-45d8-9a6c-8f90a37c278a";
const lit = (text) => ({ type: "literal", text });
const v = (id) => ({ type: "inputVariable", id });
export const PROMPT_CONFIG = {
  modelParameters: { gptParameters: { temperature: 0.4 }, modelType: "gpt-41-mini" },
  version: "GptDynamicPrompt-2",
  prompt: [
    lit("You write SMS text messages that a customer service agent sends to a customer.\nRules: plain text only, friendly and professional, short (aim for under 160 characters, never over 300). No emojis. No placeholders or square brackets: use the real names given below. Do not add a signature or sign-off, the agent's name is added separately. Write in the same language as the agent's notes.\n\nCustomer first name: "),
    v("Customer"),
    lit("\nAgent first name: "),
    v("Agent"),
    lit("\nWhat the message should do: "),
    v("Task"),
    lit("\nAgent's draft or notes (may be empty): "),
    v("Draft"),
    lit("\n\nIf a draft is given, improve it and keep its meaning. Return only the text of the SMS."),
  ],
  definitions: {
    data: [],
    output: { formats: ["text"] },
    inputs: ["Customer", "Agent", "Task", "Draft"].map((id) => ({ text: id, type: "text", id })),
  },
};
