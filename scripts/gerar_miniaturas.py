"""Gera uma miniatura estática (WebP) do primeiro quadro de cada GIF.

As listas do app mostram a miniatura (poucos KB) em vez do GIF animado (2-3 MB cada);
o GIF só é carregado no detalhe e no treino. Rode sempre que entrar GIF novo:

    python scripts/gerar_miniaturas.py
"""
import json
import sys
from pathlib import Path

from PIL import Image

RAIZ = Path(__file__).resolve().parent.parent
ASSETS = RAIZ / "android" / "app" / "src" / "main" / "assets"
GIFS = ASSETS / "gifs"
THUMBS = ASSETS / "thumbs"
LADO = 360


def main() -> int:
    THUMBS.mkdir(exist_ok=True)
    por_nome = {p.name.lower(): p for p in GIFS.glob("*.gif")}
    exercicios = json.loads((ASSETS / "exercises.json").read_text(encoding="utf-8"))
    feitos = faltando = 0
    for ex in exercicios:
        nome = ex.get("gif_file") or f"{ex['name']}.gif"
        origem = por_nome.get(nome.lower())
        if origem is None:
            faltando += 1
            continue
        destino = THUMBS / (nome[:-4] + ".webp")
        if destino.exists() and destino.stat().st_mtime >= origem.stat().st_mtime:
            feitos += 1
            continue
        with Image.open(origem) as im:
            im.seek(0)
            quadro = im.convert("RGB")
        quadro.thumbnail((LADO, LADO), Image.LANCZOS)
        quadro.save(destino, "WEBP", quality=74, method=4)
        feitos += 1
    total = sum(p.stat().st_size for p in THUMBS.glob("*.webp"))
    print(f"{feitos} miniaturas ({total / 1e6:.1f} MB), {faltando} exercícios sem GIF")
    assert feitos > 0, "nenhuma miniatura gerada: a pasta de GIFs está no lugar?"
    return 0


if __name__ == "__main__":
    sys.exit(main())
