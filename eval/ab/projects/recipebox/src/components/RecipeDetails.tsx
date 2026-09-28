import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { API_URL } from "../api/client";
import type { Recipe } from "../api/recipes";
import { ReviewForm } from "./ReviewForm";

export function RecipeDetails({ id }: { id: string }) {
  const { t } = useTranslation();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  useEffect(() => {
    fetch(`${API_URL}/api/recipes/${id}`, { credentials: "include" })
      .then((r) => r.json())
      .then(setRecipe);
  }, [id]);
  if (!recipe) return null;
  return (
    <section>
      <h2>{recipe.title}</h2>
      <h3>{t("details.ingredients")}</h3>
      <ul>{recipe.ingredients.map((i) => <li key={i}>{i}</li>)}</ul>
      <h3>{t("details.steps")}</h3>
      <ol>{recipe.steps.map((s) => <li key={s}>{s}</li>)}</ol>
      <button>{t("details.save")}</button>
      <ReviewForm recipeId={recipe.id} />
    </section>
  );
}
