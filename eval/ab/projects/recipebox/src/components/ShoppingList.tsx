import { useTranslation } from "react-i18next";

export function ShoppingList({ items, onChange }: { items: string[]; onChange: (items: string[]) => void }) {
  const { t } = useTranslation();
  return (
    <aside>
      <h2>{t("list.title")}</h2>
      <ul>
        {items.map((item, i) => (
          <li key={`${item}-${i}`}>{item}</li>
        ))}
      </ul>
      <button onClick={() => onChange([])}>{t("list.clear")}</button>
    </aside>
  );
}
