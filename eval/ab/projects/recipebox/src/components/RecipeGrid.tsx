import { useTranslation } from "react-i18next";
import { useRecipes } from "../api/recipes";
import { RecipeCard } from "./RecipeCard";
import styles from "./RecipeGrid.module.css";

export function RecipeGrid({ onOpen, onAddToList }: { onOpen: (id: string) => void; onAddToList: (items: string[]) => void }) {
  const { t } = useTranslation();
  const { data: recipes = [] } = useRecipes();
  if (recipes.length === 0) return <p>{t("grid.empty")}</p>;
  return (
    <section>
      <h2 className={styles.title}>{t("grid.title")}</h2>
      <div className={styles.grid}>
        {recipes.map((r) => (
          <RecipeCard key={r.id} recipe={r} onOpen={() => onOpen(r.id)} onAddToList={() => onAddToList(r.ingredients)} />
        ))}
      </div>
    </section>
  );
}
