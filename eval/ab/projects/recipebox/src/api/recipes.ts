import { useQuery } from "@tanstack/react-query";
import { getJson } from "./client";

export interface Recipe {
  id: string;
  title: string;
  imageUrl: string;
  prepMinutes: number;
  cookMinutes: number;
  ingredients: string[];
  steps: string[];
}

export function useRecipes() {
  return useQuery({ queryKey: ["recipes"], queryFn: () => getJson<Recipe[]>("/api/recipes") });
}
