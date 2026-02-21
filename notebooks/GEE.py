import pandas as pd
import numpy as np
import rasterio
from scipy.interpolate import griddata
import os

# ==========================================
# 1. CẤU HÌNH ĐƯỜNG DẪN
# ==========================================
PATH_DEM = "C:/Users/Administrator/2026/FPT_AIO20A02/DAP391m/data/input/DEM_NASADEM_Fixed.tif"
PATH_WEATHER_CSV = "C:/Users/Administrator/2026/FPT_AIO20A02/DAP391m/data/output/weather_daily_all_locations.csv"
OUTPUT_FINAL = "C:/Users/Administrator/2026/FPT_AIO20A02/DAP391m/data/output/READY_FOR_MODEL/Final_Stacked_Input.tif"

os.makedirs(os.path.dirname(OUTPUT_FINAL), exist_ok=True)

# ==========================================
# 2. HÀM CHUẨN HÓA (MIN-MAX SCALING)
# ==========================================
def normalize(array):
    array_min, array_max = array.min(), array.max()
    if array_max - array_min == 0:
        return array
    return (array - array_min) / (array_max - array_min)

# ==========================================
# 3. PIPELINE TỔNG HỢP (ALL-IN-ONE)
# ==========================================
def run_full_pipeline(dem_path, csv_path, out_path):
    print("🚀 Bắt đầu Pipeline tổng hợp dữ liệu...")

    # --- BƯỚC A: ĐỌC DEM VÀ TÍNH ĐỊA HÌNH ---
    with rasterio.open(dem_path) as src:
        profile = src.profile
        dem = src.read(1).astype(np.float32)
        grid_shape = src.shape
        transform = src.transform
        res = src.res[0]

        print("  -> Đang tính toán Slope và SeaLevel...")
        dx, dy = np.gradient(dem, res)
        slope = np.degrees(np.arctan(np.sqrt(dx**2 + dy**2)))
        sea_level = (dem < 2.5).astype(np.float32)

        # Tạo grid tọa độ (Chỉ làm 1 lần)
        rows, cols = np.indices(grid_shape)
        lons, lats = rasterio.transform.xy(transform, rows.flatten(), cols.flatten())
        grid_points = np.array([lons, lats]).T

    # --- BƯỚC B: XỬ LÝ DỮ LIỆU THỜI TIẾT ---
    print("  -> Đang xử lý dữ liệu từ CSV...")
    df = pd.read_csv(csv_path)
    # Lấy trung bình để tạo ảnh tĩnh (Dễ thay đổi nếu bạn muốn làm theo ngày)
    df_grouped = df.groupby(['location', 'latitude', 'longitude']).mean(numeric_only=True).reset_index()
    points = df_grouped[['longitude', 'latitude']].values
    
    weather_cols = [
        'precipitation_sum', 
        'humidity_mean', 
        'soil_moisture_0_7cm', 
        'soil_moisture_7_28cm'
    ]

    # --- BƯỚC C: GHI FILE ĐA BĂNG (7 BANDS) ---
    # Cập nhật profile: 7 lớp, kiểu float32
    profile.update(count=3 + len(weather_cols), dtype=rasterio.float32)

    with rasterio.open(out_path, 'w', **profile) as dst:
        # Ghi các lớp địa hình (Đã chuẩn hóa)
        print("  -> Đang ghi Band 1: Elevation")
        dst.write(normalize(dem), 1)
        
        print("  -> Đang ghi Band 2: Slope")
        dst.write(normalize(slope), 2)
        
        print("  -> Đang ghi Band 3: SeaLevel Risk")
        dst.write(sea_level, 3) # SeaLevel là 0/1 nên không cần normalize thêm

        # Nội suy và ghi các lớp thời tiết
        for i, col in enumerate(weather_cols):
            print(f"  -> Đang nội suy & ghi Band {i+4}: {col}")
            vals = df_grouped[col].values
            
            # Nội suy linear
            grid_vals = griddata(points, vals, grid_points, method='linear')
            grid_vals = np.nan_to_num(grid_vals, nan=0.0)
            
            # Reshape và chuẩn hóa
            final_band = grid_vals.reshape(grid_shape).astype(np.float32)
            dst.write(normalize(final_band), i + 4)

    print("\n" + "="*40)
    print(f"🎉 HOÀN THÀNH!")
    print(f"📂 File gộp 7-bands: {out_path}")
    print("Thứ tự Band: 1.Elev, 2.Slope, 3.SeaLevel, 4.Rain, 5.Humid, 6.Soil0-7, 7.Soil7-28")
    print("="*40)

# ==========================================
# THỰC THI
# ==========================================
if __name__ == "__main__":
    try:
        run_full_pipeline(PATH_DEM, PATH_WEATHER_CSV, OUTPUT_FINAL)
    except Exception as e:
        print(f"❌ LỖI: {e}")
import pandas as pd
import numpy as np
import rasterio
from scipy.interpolate import griddata
import os

# ==========================================
# 1. CẤU HÌNH ĐƯỜNG DẪN
# ==========================================
PATH_DEM = "C:/Users/Administrator/2026/FPT_AIO20A02/DAP391m/data/input/DEM_NASADEM_Fixed.tif"
PATH_WEATHER_CSV = "C:/Users/Administrator/2026/FPT_AIO20A02/DAP391m/data/output/weather_daily_all_locations.csv"
OUTPUT_FINAL = "C:/Users/Administrator/2026/FPT_AIO20A02/DAP391m/data/output/READY_FOR_MODEL/Final_Stacked_Input.tif"

os.makedirs(os.path.dirname(OUTPUT_FINAL), exist_ok=True)

# ==========================================
# 2. HÀM CHUẨN HÓA (MIN-MAX SCALING)
# ==========================================
def normalize(array):
    array_min, array_max = array.min(), array.max()
    if array_max - array_min == 0:
        return array
    return (array - array_min) / (array_max - array_min)

# ==========================================
# 3. PIPELINE TỔNG HỢP (ALL-IN-ONE)
# ==========================================
def run_full_pipeline(dem_path, csv_path, out_path):
    print("🚀 Bắt đầu Pipeline tổng hợp dữ liệu...")

    # --- BƯỚC A: ĐỌC DEM VÀ TÍNH ĐỊA HÌNH ---
    with rasterio.open(dem_path) as src:
        profile = src.profile
        dem = src.read(1).astype(np.float32)
        grid_shape = src.shape
        transform = src.transform
        res = src.res[0]

        print("  -> Đang tính toán Slope và SeaLevel...")
        dx, dy = np.gradient(dem, res)
        slope = np.degrees(np.arctan(np.sqrt(dx**2 + dy**2)))
        sea_level = (dem < 2.5).astype(np.float32)

        # Tạo grid tọa độ (Chỉ làm 1 lần)
        rows, cols = np.indices(grid_shape)
        lons, lats = rasterio.transform.xy(transform, rows.flatten(), cols.flatten())
        grid_points = np.array([lons, lats]).T

    # --- BƯỚC B: XỬ LÝ DỮ LIỆU THỜI TIẾT ---
    print("  -> Đang xử lý dữ liệu từ CSV...")
    df = pd.read_csv(csv_path)
    # Lấy trung bình để tạo ảnh tĩnh (Dễ thay đổi nếu bạn muốn làm theo ngày)
    df_grouped = df.groupby(['location', 'latitude', 'longitude']).mean(numeric_only=True).reset_index()
    points = df_grouped[['longitude', 'latitude']].values
    
    weather_cols = [
        'precipitation_sum', 
        'humidity_mean', 
        'soil_moisture_0_7cm', 
        'soil_moisture_7_28cm'
    ]

    # --- BƯỚC C: GHI FILE ĐA BĂNG (7 BANDS) ---
    # Cập nhật profile: 7 lớp, kiểu float32
    profile.update(count=3 + len(weather_cols), dtype=rasterio.float32)

    with rasterio.open(out_path, 'w', **profile) as dst:
        # Ghi các lớp địa hình (Đã chuẩn hóa)
        print("  -> Đang ghi Band 1: Elevation")
        dst.write(normalize(dem), 1)
        
        print("  -> Đang ghi Band 2: Slope")
        dst.write(normalize(slope), 2)
        
        print("  -> Đang ghi Band 3: SeaLevel Risk")
        dst.write(sea_level, 3) # SeaLevel là 0/1 nên không cần normalize thêm

        # Nội suy và ghi các lớp thời tiết
        for i, col in enumerate(weather_cols):
            print(f"  -> Đang nội suy & ghi Band {i+4}: {col}")
            vals = df_grouped[col].values
            
            # Nội suy linear
            grid_vals = griddata(points, vals, grid_points, method='linear')
            grid_vals = np.nan_to_num(grid_vals, nan=0.0)
            
            # Reshape và chuẩn hóa
            final_band = grid_vals.reshape(grid_shape).astype(np.float32)
            dst.write(normalize(final_band), i + 4)

    print("\n" + "="*40)
    print(f"🎉 HOÀN THÀNH!")
    print(f"📂 File gộp 7-bands: {out_path}")
    print("Thứ tự Band: 1.Elev, 2.Slope, 3.SeaLevel, 4.Rain, 5.Humid, 6.Soil0-7, 7.Soil7-28")
    print("="*40)

# ==========================================
# THỰC THI
# ==========================================
if __name__ == "__main__":
    try:
        run_full_pipeline(PATH_DEM, PATH_WEATHER_CSV, OUTPUT_FINAL)
    except Exception as e:
        print(f"❌ LỖI: {e}")