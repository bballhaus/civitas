"""
Simple test - just wait for page to load and find visible rows
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import time

SEARCH_URL = 'https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx'

def simple_test():
    print("Simple Test - Wait and Find")
    print("=" * 80)
    
    # Set up Chrome
    options = webdriver.ChromeOptions()
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--window-size=1920,1080')
    
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    
    try:
        print("\n1. Loading page...")
        driver.get(SEARCH_URL)
        
        # Simple approach: just wait 10 seconds
        print("2. Waiting 10 seconds for everything to load...")
        for i in range(10):
            time.sleep(1)
            print(f"   {i+1}...")
        
        print("\n3. Finding visible event rows...")
        
        # Get all rows that start with tblBodyTr label
        all_rows = driver.find_elements(By.CSS_SELECTOR, '[data-if-label^="tblBodyTr"]')
        print(f"   Total rows with tblBodyTr label: {len(all_rows)}")
        
        # Filter out hidden ones
        visible_rows = []
        for row in all_rows:
            row_class = row.get_attribute('class') or ''
            if 'if-hide' not in row_class and row.is_displayed():
                visible_rows.append(row)
        
        print(f"   Visible rows: {len(visible_rows)}")
        
        print("\n4. Extracting data from first 3 events:")
        print("-" * 80)
        
        for i, row in enumerate(visible_rows[:3]):
            print(f"\nEvent {i+1}:")
            
            try:
                event_id = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventId"]').text.strip()
                print(f"  Event ID: {event_id}")
            except:
                print(f"  Event ID: NOT FOUND")
            
            try:
                title = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventName"]').text.strip()
                print(f"  Title: {title[:70]}...")
            except:
                print(f"  Title: NOT FOUND")
            
            try:
                dept = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdDepName"]').text.strip()
                print(f"  Dept: {dept}")
            except:
                print(f"  Dept: NOT FOUND")
            
            try:
                end_date = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEndDate"]').text.strip()
                print(f"  End Date: {end_date}")
            except:
                pass
            
            try:
                status = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdStatus"]').text.strip()
                print(f"  Status: {status}")
            except:
                pass
            
            print("-" * 40)
        
        print("\n" + "=" * 80)
        if visible_rows:
            print(f"✓ SUCCESS! Found {len(visible_rows)} events")
        else:
            print("✗ No events found - may need to adjust selectors")
        
        print("\nPress Enter to close...")
        input()
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        driver.quit()


if __name__ == '__main__':
    simple_test()