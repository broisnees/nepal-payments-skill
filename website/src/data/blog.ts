import { getCollection, type CollectionEntry } from "astro:content";

export type Post = CollectionEntry<"blog">;

export const getPosts = async () => (await getCollection("blog")).sort((a, b) => a.data.order - b.data.order);
