import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr }, de: { translation: de } },
  lng: navigator.language.slice(0, 2),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
