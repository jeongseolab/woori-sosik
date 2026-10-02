"""연습장 효과 그림 한 장(static/dodge/fx.webp) 아래쪽에 롤 파티클 텍스처를 덧붙인다. 개발자 PC 에서 한 번 돌리는 도구.

위쪽(BASE_H 줄까지) 은 처음 묶은 43장 그대로 두고, 그 아래를 이 파일의 ADD 로 다시 채운다(자리는 몇 번 돌려도 같다.
다만 webp 를 다시 압축하니 위쪽 그림도 돌릴 때마다 조금씩 뭉개진다. 텍스처를 바꿀 때만 돌린다).
텍스처는 CommunityDragon 이 PNG 로 푼 롤 클라이언트 파티클(game/assets/characters/<챔피언>/skins/base/particles/*.png).
끝나면 static/dodge.js 의 FX_MAP 에 넣을 자리를 찍는다.

  python tools/fx_atlas.py
"""
import io
import os
import urllib.request

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ATLAS = os.path.join(HERE, "..", "static", "dodge", "fx.webp")
BASE_H = 1569
CDRAGON = "https://raw.communitydragon.org/latest/game/assets/characters/"
AMB = "ambessa/skins/base/particles/ambessa_base_"
# FX_MAP 이름 → 텍스처(앞: CDRAGON 뒤 경로). 암베사: Q 반원 베기·Q2 내려찍기, W 버티기·충격, E 사슬 회오리, R 처형, 패시브 돌진
ADD = {
    "amb_w_ring": AMB + "w_release_ring_shape.png",
    "amb_r_decal": AMB + "r_hurl_impact_decal_shape.png",
    "amb_r_marker": "ambessa/skins/base/particles/ambessa_r_marker.png",
    "amb_q_sweet": AMB + "q_broad_sweetspot_shape.png",
    "amb_w_shock": AMB + "w_release_shockwave_shape.png",
    "amb_r_lines": AMB + "r_decalorganic_alpha.png",
    "amb_q_tar": AMB + "q_broad_tar_shape.png",
    "amb_e_trail": AMB + "e_swipetrail.png",
    "amb_q_slash": AMB + "q_broad_swipe_slash_alpha.png",
    "amb_q_body": AMB + "q_broad_swipe_body_shape.png",
    "amb_q_crescent": AMB + "q_broad_swipe_stylized_alpha.png",
    "amb_q_chain": AMB + "q_broad_swipe_chains_shape.png",
    "amb_q2_impact": AMB + "q_precise_whipsmash_impact_shape.png",
    "amb_q2_wave": AMB + "q_precise_whipsmash_dirwave.png",
    "amb_q2_explo": AMB + "q_precise_whipexposion_shape_1.png",
    "amb_q2_swipe": AMB + "q_precise_whipsmash_swipe_alpha.png",
    "amb_w_shield": AMB + "w_shieldgradient_shape.png",
    "amb_w_flash": AMB + "w_flash_shape.png",
    "amb_w_wind": AMB + "w_parry_wind_shape.png",
    "amb_e_ring": AMB + "e_oneshot_ring_swipe_shape.png",
    "amb_e_edge": AMB + "e_swirl_sharpedge_shape.png",
    "amb_r_impact": AMB + "r_hurl_impact_shape.png",
    "amb_r_residual": AMB + "r_residual_decal_shape.png",
    "amb_dash": AMB + "z_dash_indicator_shape1.png",
    "amb_motes": AMB + "z_motes_shape.png",
    "amb_q2_decal": AMB + "q_precise_whip_decal_shape.png",
}


def get(path):
    req = urllib.request.Request(CDRAGON + path, headers={"User-Agent": "tiergg-champ-models/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return Image.open(io.BytesIO(r.read())).convert("RGBA")


def main():
    base = Image.open(ATLAS).convert("RGBA")
    W = base.width
    imgs = {k: get(p) for k, p in ADD.items()}
    # 줄(선반) 채우기: 큰 것부터, 2px 띄워서(옆 칸이 번지지 않게)
    order = sorted(imgs, key=lambda k: (-imgs[k].height, -imgs[k].width))
    places, x, y, row_h = {}, 0, BASE_H + 1, 0
    for k in order:
        w, h = imgs[k].size
        if x + w > W:
            x, y, row_h = 0, y + row_h + 2, 0
        places[k] = (x, y, w, h)
        x += w + 2
        row_h = max(row_h, h)
    out = Image.new("RGBA", (W, y + row_h))
    out.paste(base.crop((0, 0, W, BASE_H)), (0, 0))
    for k, (px, py, _w, _h) in places.items():
        out.paste(imgs[k], (px, py))
    out.save(ATLAS, "WEBP", quality=90, method=6)
    for k in ADD:
        print('    %s: [%d, %d, %d, %d],' % ((k,) + places[k]))
    print("크기", out.size)


if __name__ == "__main__":
    main()
