// Parses a recipe pasted as plain text: a title line, an "Ingredients" block and a "Method" block.
export interface ImportedRecipe {
  title: string;
  ingredients: string[];
  steps: string[];
}

export function importPastedRecipe(text: string): ImportedRecipe {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const title = lines.find((l) => l.length > 0) ?? "Untitled";
  const ingredients: string[] = [];
  const steps: string[] = [];
  let section: "none" | "ingredients" | "steps" = "none";
  for (const line of lines.slice(1)) {
    if (/^ingredients:?$/i.test(line)) section = "ingredients";
    else if (/^(method|steps|directions):?$/i.test(line)) section = "steps";
    else if (line && section === "ingredients") ingredients.push(line.replace(/^[-*•]\s*/, ""));
    else if (line && section === "steps") steps.push(line.replace(/^\d+[.)]\s*/, ""));
  }
  return { title, ingredients, steps };
}
