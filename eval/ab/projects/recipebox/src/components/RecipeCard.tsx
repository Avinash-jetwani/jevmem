import type { Recipe } from "../api/recipes";

// One of the first components, from before i18n and CSS modules.
export function RecipeCard({ recipe, onOpen, onAddToList }: { recipe: Recipe; onOpen: () => void; onAddToList: () => void }) {
  return (
    <article style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }} onClick={onOpen}>
      <img src={recipe.imageUrl} alt={recipe.title} style={{ width: "100%", borderRadius: 4 }} />
      <h3 style={{ margin: "8px 0 4px" }}>{recipe.title}</h3>
      <p style={{ color: "#666", margin: 0 }}>{recipe.cookMinutes} min cooking</p>
    </article>
  );
}
