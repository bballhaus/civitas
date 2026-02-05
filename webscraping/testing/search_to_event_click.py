"""
ONE EVENT TEST - Tab-Aware Scraper
Tests scraping just the first event
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import time

SEARCH_URL = 'https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx'

def scrape_event_page(driver, wait):
    """Scrape data from event detail page - using your proven code"""
    event_data = {
        'event_url': driver.current_url,
        'event_id': '',
        'title': '',
        'description': '',
        'contact_name': '',
        'contact_email': '',
        'contact_phone': '',
        'department': '',
        'start_date': '',
        'end_date': '',
        'format': ''
    }
    
    # Extract event ID from URL
    parts = driver.current_url.split('/')
    if len(parts) >= 4:
        event_data['event_id'] = f"{parts[-2]}/{parts[-1]}"
    
    # Wait for JavaScript to load data - YOUR PROVEN TIMING
    try:
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, '[data-if-label="eventName"]'))
        )
        time.sleep(3)
    except:
        pass
    
    # Extract all fields
    try:
        title_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventName"]')
        title = title_elem.text.strip()
        if title and title != '[Event Title]':
            event_data['title'] = title
    except:
        pass
    
    try:
        desc_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="descriptiondetails"]')
        desc = desc_elem.text.strip()
        if desc and desc != '[Detail Description]':
            event_data['description'] = desc
    except:
        pass
    
    try:
        contact_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="contactName"]')
        contact = contact_elem.text.strip()
        if contact and contact != '[Contact Name]':
            event_data['contact_name'] = contact
    except:
        pass
    
    try:
        email_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="emailAnchor"]')
        email = email_elem.text.strip()
        if email and email != '[EmailAddress]':
            event_data['contact_email'] = email
    except:
        try:
            email_elem = driver.find_element(By.ID, 'RESP_INQ_DL0_WK_EMAILID')
            email = email_elem.text.strip()
            if email:
                event_data['contact_email'] = email
        except:
            pass
    
    try:
        phone_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="phoneText"]')
        phone = phone_elem.text.strip()
        if phone and phone != '[Phone Number]':
            event_data['contact_phone'] = phone
    except:
        pass
    
    try:
        dept_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="dept"]')
        dept = dept_elem.text.strip()
        if dept:
            event_data['department'] = dept
    except:
        pass
    
    try:
        start_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventStartDate"]')
        start_date = start_elem.text.strip()
        if start_date:
            event_data['start_date'] = start_date
    except:
        pass
    
    try:
        end_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventEndDate"]')
        end_date = end_elem.text.strip()
        if end_date:
            event_data['end_date'] = end_date
    except:
        pass
    
    try:
        format1_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="format1"]')
        format2_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="format2"]')
        format1 = format1_elem.text.strip()
        format2 = format2_elem.text.strip()
        if format1 or format2:
            event_data['format'] = f"{format1} / {format2}".strip(' /')
    except:
        pass
    
    return event_data


def test_one_event():
    print("\n" + "=" * 80)
    print("ONE EVENT TEST - Tab-Aware Scraper")
    print("=" * 80)
    
    options = webdriver.ChromeOptions()
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--window-size=1920,1080')
    
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    wait = WebDriverWait(driver, 20)
    
    try:
        # Load search page
        print("\n1. Loading search page...")
        driver.get(SEARCH_URL)
        time.sleep(10)
        
        # Find first event
        print("\n2. Finding first event...")
        all_rows = driver.find_elements(By.CSS_SELECTOR, '[data-if-label^="tblBodyTr"]')
        visible_rows = [row for row in all_rows if 'if-hide' not in (row.get_attribute('class') or '') and row.is_displayed()]
        
        if not visible_rows:
            print("  No events found!")
            return
        
        first_row = visible_rows[0]
        
        # Get event ID
        try:
            event_id_text = first_row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventId"]').text.strip()
            print(f"  Event ID: {event_id_text}")
        except:
            print("  Could not get event ID")
        
        # Remember current tab
        original_window = driver.current_window_handle
        original_windows = driver.window_handles
        print(f"  Current tabs: {len(original_windows)}")
        
        # Click event
        print("\n3. Clicking event...")
        event_id_cell = first_row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventId"]')
        event_id_cell.click()
        
        # Wait for new tab
        print("  Waiting for new tab...")
        time.sleep(2)
        
        # Check if a new tab opened
        new_windows = driver.window_handles
        print(f"  Tabs after click: {len(new_windows)}")
        
        if len(new_windows) > len(original_windows):
            # New tab opened!
            print("\n4. ✓ New tab opened! Switching to it...")
            new_window = [w for w in new_windows if w not in original_windows][0]
            driver.switch_to.window(new_window)
            
            print(f"  Current URL: {driver.current_url}")
            
            # Scrape the event page
            print("\n5. Scraping event page...")
            event_data = scrape_event_page(driver, wait)
            
            # Display results
            print("\n" + "=" * 80)
            print("SCRAPED DATA:")
            print("=" * 80)
            print(f"Event ID: {event_data['event_id']}")
            print(f"URL: {event_data['event_url']}")
            print(f"Title: {event_data['title']}")
            print(f"Department: {event_data['department']}")
            print(f"Contact Name: {event_data['contact_name']}")
            print(f"Contact Email: {event_data['contact_email']}")
            print(f"Contact Phone: {event_data['contact_phone']}")
            print(f"Start Date: {event_data['start_date']}")
            print(f"End Date: {event_data['end_date']}")
            print(f"Format: {event_data['format']}")
            print(f"\nDescription: {event_data['description'][:200]}..." if event_data['description'] else "Description: (none)")
            print("=" * 80)
            
            # Check if we got data
            if event_data['title'] and event_data['contact_email']:
                print("\n✓ SUCCESS! Got title and email!")
            elif event_data['title']:
                print("\n⚠ Got title but no email")
            else:
                print("\n✗ FAILED - No data scraped")
            
            # Close the tab and switch back
            print("\n6. Closing event tab and returning to search page...")
            driver.close()
            driver.switch_to.window(original_window)
            print("  ✓ Back on search page")
            
        else:
            print("\n4. ⚠ No new tab opened - same tab navigation")
            event_data = scrape_event_page(driver, wait)
            
            print("\n" + "=" * 80)
            print("SCRAPED DATA:")
            print(f"Title: {event_data['title']}")
            print(f"Email: {event_data['contact_email']}")
        
        print("\n" + "=" * 80)
        print("Test complete! Press Enter to close...")
        input()
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        driver.quit()
        print("\nBrowser closed.")


if __name__ == '__main__':
    test_one_event()