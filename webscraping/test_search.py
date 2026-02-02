"""
Test script to verify the search results table is being parsed correctly
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import time

SEARCH_URL = 'https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx'

def test_search_results():
    print(f"Testing search results parsing on: {SEARCH_URL}")
    print("=" * 80)
    
    # Set up Chrome
    options = webdriver.ChromeOptions()
    # Show browser so you can see what's happening
    # options.add_argument('--headless')  # Uncomment to hide
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--window-size=1920,1080')
    
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    wait = WebDriverWait(driver, 30)  # Increased timeout to 30 seconds
    
    try:
        # Load the search page
        print("\n1. Loading search page...")
        driver.get(SEARCH_URL)
        
        # Wait for table to load and populate with data
        print("2. Waiting for table to populate (this may take a while)...")
        
        # First, wait for the table structure to exist
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, '[data-if-label="tblBodyTr"]'))
        )
        print("   Table structure loaded, waiting for data to populate...")
        
        # Now wait for actual data to appear (retry logic)
        max_retries = 10
        retry_count = 0
        event_rows = []
        
        while retry_count < max_retries:
            time.sleep(2)  # Wait between checks
            event_rows = driver.find_elements(By.CSS_SELECTOR, '[data-if-label="tblBodyTr"]')
            
            if event_rows:
                # Check if first row has actual data (not empty)
                try:
                    first_row = event_rows[0]
                    event_id_elem = first_row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventId"]')
                    event_id = event_id_elem.text.strip()
                    
                    if event_id and len(event_id) > 0:
                        print(f"   ✓ Data loaded after {(retry_count + 1) * 2} seconds")
                        break
                except:
                    pass
            
            retry_count += 1
            print(f"   Still waiting... ({retry_count}/{max_retries})")
        
        if retry_count >= max_retries:
            print("   ⚠ Timeout waiting for data, proceeding anyway...")
        
        # Find all event rows
        print("\n3. Finding event rows...")
        event_rows = driver.find_elements(By.CSS_SELECTOR, '[data-if-label="tblBodyTr"]')
        print(f"Found {len(event_rows)} event rows")
        
        # Parse first 3 events as examples
        print("\n4. Parsing first 3 events:")
        print("-" * 80)
        
        for i, row in enumerate(event_rows[:3]):
            print(f"\nEvent {i+1}:")
            
            # Event ID
            try:
                event_id_elem = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventId"]')
                event_id = event_id_elem.text.strip()
                print(f"  Event ID: {event_id}")
            except:
                print("  Event ID: NOT FOUND")
            
            # Event Name/Title
            try:
                event_name_elem = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventName"]')
                title = event_name_elem.text.strip()
                print(f"  Title: {title[:60]}...")
                
                # Try to get the link
                try:
                    link = event_name_elem.find_element(By.TAG_NAME, 'a')
                    url = link.get_attribute('href')
                    print(f"  URL: {url}")
                except:
                    print("  URL: NO LINK FOUND")
            except:
                print("  Title: NOT FOUND")
            
            # Department
            try:
                dept_elem = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdDeptName"]')
                dept = dept_elem.text.strip()
                print(f"  Dept: {dept}")
            except:
                print("  Dept: NOT FOUND")
            
            print("-" * 40)
        
        print("\n" + "=" * 80)
        print("✓ Test complete!")
        print(f"\nTotal events available: {len(event_rows)}")
        print("\nIf you see real data above (not placeholders), the scraper should work!")
        print("Press Enter to close browser...")
        
        input()
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        driver.quit()
        print("\nBrowser closed.")


if __name__ == '__main__':
    test_search_results()