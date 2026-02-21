import rasterio
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LightSource

def visual_pro_max(tif_path):
    with rasterio.open(tif_path) as src:
        # 1. Elevation với hiệu ứng đổ bóng (Hillshade)
        dem = src.read(1)
        ls = LightSource(azdeg=315, altdeg=45)
        hillshade = ls.hillshade(dem, vert_exag=0.1)
        
        # 2. Các lớp khác
        slope = src.read(2)
        rain = src.read(4)
        soil = src.read(6)

        fig, axs = plt.subplots(2, 2, figsize=(16, 12))

        # Hiển thị DEM kèm Hillshade (Nhìn rõ khối địa hình)
        axs[0, 0].imshow(hillshade, cmap='gray')
        axs[0, 0].imshow(dem, cmap='terrain', alpha=0.5) # Chồng lớp màu địa hình lên
        axs[0, 0].set_title("1. Địa hình thực tế (Đổ bóng 3D)")

        # Hiển thị Slope (Dùng bảng màu nóng để thấy độ dốc)
        im2 = axs[0, 1].imshow(slope, cmap='magma')
        plt.colorbar(im2, ax=axs[0, 1])
        axs[0, 1].set_title("2. Độ dốc (Tím: Bằng phẳng - Vàng: Dốc gắt)")

        # Hiển thị Lượng mưa (Dùng bảng màu xanh nước biển)
        im3 = axs[1, 0].imshow(rain, cmap='Blues')
        plt.colorbar(im3, ax=axs[1, 0])
        axs[1, 0].set_title("3. Phân bố mưa (Nội suy mượt)")

        # Hiển thị Độ ẩm đất
        im4 = axs[1, 1].imshow(soil, cmap='YlGnBu')
        plt.colorbar(im4, ax=axs[1, 1])
        axs[1, 1].set_title("4. Độ ẩm đất (Xanh đậm: No nước)")

        for ax in axs.flat: ax.axis('off')
        plt.tight_layout()
        plt.show()

visual_pro_max("C:/Users/Administrator/2026/FPT_AIO20A02/DAP391m/data/output/READY_FOR_MODEL/Final_Stacked_Input.tif")