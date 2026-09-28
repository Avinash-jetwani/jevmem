import { useState } from "react";
import { RecipeGrid } from "./components/RecipeGrid";
import { RecipeDetails } from "./components/RecipeDetails";
import { ShoppingList } from "./components/ShoppingList";

export function App() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [list, setList] = useState<string[]>([]);
  return (
    <main>
      <RecipeGrid onOpen={setOpenId} onAddToList={(items) => setList((l) => [...l, ...items])} />
      {openId && <RecipeDetails id={openId} />}
      <ShoppingList items={list} onChange={setList} />
    </main>
  );
}
