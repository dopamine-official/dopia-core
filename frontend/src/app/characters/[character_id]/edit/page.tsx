import { CharacterEditor } from "@/components/character-editor";
export default async function Page({
  params,
}: {
  params: Promise<{ character_id: string }>;
}) {
  const { character_id } = await params;
  return <CharacterEditor key={character_id} characterId={character_id} />;
}
