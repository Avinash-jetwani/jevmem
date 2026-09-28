import { useState } from "react";
import { useTranslation } from "react-i18next";
import { API_URL } from "../api/client";

export function ReviewForm({ recipeId }: { recipeId: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const submit = async () => {
    await fetch(`${API_URL}/api/recipes/${recipeId}/reviews`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    setText("");
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={t("review.placeholder")} />
      <button type="submit">{t("review.submit")}</button>
    </form>
  );
}
